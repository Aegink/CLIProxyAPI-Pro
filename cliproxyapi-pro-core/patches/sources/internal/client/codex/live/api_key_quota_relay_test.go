package live

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/pro/apikeypolicy"
)

func TestCreateClientSecretRetainsServerIssuedAPIKeyIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := &Handler{clientSecrets: newClientSecretStore()}
	identity, errIdentity := apikeypolicy.NewAuthenticatedAPIKeyIdentity("issuer-key")
	if errIdentity != nil {
		t.Fatal(errIdentity)
	}
	router := gin.New()
	router.POST("/v1/realtime/client_secrets", func(c *gin.Context) {
		c.Set("userApiKey", "issuer-key")
		c.Set("accessProvider", "config-inline")
		c.Request = c.Request.WithContext(apikeypolicy.WithIdentity(c.Request.Context(), identity))
	}, handler.CreateClientSecret)
	request := httptest.NewRequest(http.MethodPost, "/v1/realtime/client_secrets", strings.NewReader(`{"session":{"type":"realtime","model":"gpt-realtime"}}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var response clientSecretCreateResponse
	if errDecode := json.Unmarshal(recorder.Body.Bytes(), &response); errDecode != nil {
		t.Fatal(errDecode)
	}
	authRequest := httptest.NewRequest(http.MethodPost, "/v1/realtime", nil)
	authRequest.Header.Set("Authorization", "Bearer "+response.Value)
	authorization, matched, errAuthenticate := handler.AuthenticateClientSecret(authRequest)
	if errAuthenticate != nil || !matched || authorization.IssuerAPIKeyIdentity.Hash() != identity.Hash() {
		t.Fatalf("authorization = %#v matched=%t error=%v", authorization, matched, errAuthenticate)
	}
}

func TestRealtimeRelayAdmitsAndSettlesEveryResponseTurn(t *testing.T) {
	gin.SetMode(gin.TestMode)
	upstreamEvents := make(chan string, 4)
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			messageType, payload, errRead := conn.ReadMessage()
			if errRead != nil {
				return
			}
			upstreamEvents <- string(payload)
			if strings.Contains(string(payload), `"type":"response.create"`) {
				_ = conn.WriteMessage(messageType, []byte(`{"type":"response.done","response":{"id":"resp_1","usage":{"input_tokens":4,"output_tokens":5,"total_tokens":9}}}`))
			}
		}
	}))
	defer upstreamServer.Close()

	var admissions atomic.Int64
	settled := make(chan apikeypolicy.QuotaUsageDelta, 1)
	baseDecision := apikeypolicy.RequestPolicyDecision{Mode: apikeypolicy.ModeProfile, Snapshot: &apikeypolicy.RequestPolicySnapshot{
		PolicyID: "policy", ProfileID: "profile", Quota: &apikeypolicy.Quota{Enabled: true, Epoch: 1},
	}}
	baseCtx := apikeypolicy.WithDecision(context.Background(), baseDecision)
	baseCtx = apikeypolicy.WithQuotaAdmission(baseCtx, func(_ context.Context, decision apikeypolicy.RequestPolicyDecision) (apikeypolicy.RequestPolicyDecision, error) {
		turn := admissions.Add(1)
		if turn > 1 {
			return apikeypolicy.RequestPolicyDecision{}, &apikeypolicy.QuotaExceededError{Metric: "requests", Used: 1, Limit: 1}
		}
		decision.Snapshot.QuotaAdmissionID = "admission-1"
		decision.Snapshot.QuotaUsageSettlement = func(_ context.Context, _ string, usage apikeypolicy.QuotaUsageDelta) error {
			settled <- usage
			return nil
		}
		return decision, nil
	})

	router := gin.New()
	router.GET("/v1/realtime", func(c *gin.Context) {
		upstreamURL := "ws" + strings.TrimPrefix(upstreamServer.URL, "http")
		upstream, _, errDial := websocket.DefaultDialer.Dial(upstreamURL, nil)
		if errDial != nil {
			return
		}
		upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		downstream, errUpgrade := upgrader.Upgrade(c.Writer, c.Request, nil)
		if errUpgrade != nil {
			upstream.Close()
			return
		}
		_ = relayRealtimeWebsockets(baseCtx, downstream, upstream, "gpt-realtime")
	})
	downstreamServer := httptest.NewServer(router)
	defer downstreamServer.Close()
	connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(downstreamServer.URL, "http")+"/v1/realtime", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()

	if err = connection.WriteMessage(websocket.TextMessage, []byte(`{"type":"session.update"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-upstreamEvents:
		if !strings.Contains(event, "session.update") || admissions.Load() != 0 {
			t.Fatalf("control event=%s admissions=%d", event, admissions.Load())
		}
	case <-time.After(time.Second):
		t.Fatal("control event was not relayed")
	}
	if err = connection.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-upstreamEvents:
		if !strings.Contains(event, "response.create") {
			t.Fatalf("turn event=%s", event)
		}
	case <-time.After(time.Second):
		t.Fatal("response.create was not relayed")
	}
	_, done, err := connection.ReadMessage()
	if err != nil || !strings.Contains(string(done), "response.done") {
		t.Fatalf("done=%s error=%v", done, err)
	}
	select {
	case usage := <-settled:
		if usage.Provider != "codex" || usage.Model != "gpt-realtime" || usage.TotalTokens != 9 || usage.InputTokens != 4 || usage.OutputTokens != 5 {
			t.Fatalf("settled usage=%#v", usage)
		}
	case <-time.After(time.Second):
		t.Fatal("realtime usage was not settled")
	}
	if err = connection.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create"}`)); err != nil {
		t.Fatal(err)
	}
	_, quotaError, err := connection.ReadMessage()
	if err != nil || !strings.Contains(string(quotaError), "api_key_quota_exceeded") {
		t.Fatalf("quota error=%s error=%v", quotaError, err)
	}
	select {
	case event := <-upstreamEvents:
		if strings.Contains(event, "response.create") {
			t.Fatalf("rejected turn reached upstream: %s", event)
		}
	case <-time.After(50 * time.Millisecond):
	}
	if admissions.Load() != 2 {
		t.Fatalf("admissions=%d", admissions.Load())
	}
}

func TestApplyRealtimeAPIKeyPolicyMapsModelAndEnforcesProvider(t *testing.T) {
	decision := apikeypolicy.RequestPolicyDecision{Mode: apikeypolicy.ModeProfile, Snapshot: &apikeypolicy.RequestPolicySnapshot{
		ModelMappings:    map[string]string{"voice": "gpt-realtime"},
		AllowedModels:    map[string]struct{}{"gpt-realtime": {}},
		AllowedProviders: map[string]struct{}{"codex": {}},
	}}
	ctx, model, err := applyRealtimeAPIKeyPolicy(apikeypolicy.WithDecision(context.Background(), decision), "voice")
	if err != nil || model != "gpt-realtime" {
		t.Fatalf("mapped model=%q error=%v", model, err)
	}
	mapped, ok := apikeypolicy.DecisionFromContext(ctx)
	if !ok || mapped.UsageAttribution().RequestedModel != "voice" || mapped.UsageAttribution().EffectiveModel != "gpt-realtime" {
		t.Fatalf("mapped decision=%#v", mapped)
	}
	if _, _, err = applyRealtimeAPIKeyPolicy(apikeypolicy.WithDecision(context.Background(), decision), "forbidden"); err == nil {
		t.Fatal("forbidden realtime model was accepted")
	}
	decision.Snapshot.AllowedProviders = map[string]struct{}{"claude": {}}
	if _, _, err = applyRealtimeAPIKeyPolicy(apikeypolicy.WithDecision(context.Background(), decision), "voice"); err == nil {
		t.Fatal("forbidden Codex provider was accepted")
	}
}

func TestSidebandQuotaRelaySettlesFrozenBootstrapAdmission(t *testing.T) {
	gin.SetMode(gin.TestMode)
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_, _, _ = conn.ReadMessage()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.done","response":{"id":"rtc_resp","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}`))
	}))
	defer upstreamServer.Close()
	settled := make(chan apikeypolicy.QuotaUsageDelta, 1)
	router := gin.New()
	router.GET("/sideband", func(c *gin.Context) {
		upstream, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(upstreamServer.URL, "http"), nil)
		if err != nil {
			return
		}
		upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		downstream, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			_ = upstream.Close()
			return
		}
		session := liveSession{callID: "rtc_call", quotaModel: "gpt-realtime", quotaSettlement: func(_ context.Context, _ string, usage apikeypolicy.QuotaUsageDelta) error {
			settled <- usage
			return nil
		}}
		_ = relaySidebandQuotaWebsockets(context.Background(), downstream, upstream, session)
	})
	downstreamServer := httptest.NewServer(router)
	defer downstreamServer.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(downstreamServer.URL, "http")+"/sideband", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"session.update"}`)); err != nil {
		t.Fatal(err)
	}
	if _, _, err = conn.ReadMessage(); err != nil {
		t.Fatal(err)
	}
	select {
	case usage := <-settled:
		if usage.Provider != "codex" || usage.Model != "gpt-realtime" || usage.TotalTokens != 5 || usage.InputTokens != 2 || usage.OutputTokens != 3 {
			t.Fatalf("settled usage=%#v", usage)
		}
	case <-time.After(time.Second):
		t.Fatal("sideband usage was not settled")
	}
}

// TestRealtimeQuotaRelayCompatibilityReceipt uses real HTTP/WebSocket peers to
// freeze the distinct WS and sideband settlement contracts before deduplication.
func TestRealtimeQuotaRelayCompatibilityReceipt(t *testing.T) {
	type settlement struct {
		EventID  string                       `json:"eventId"`
		Usage    apikeypolicy.QuotaUsageDelta `json:"usage"`
		Canceled bool                         `json:"canceled"`
	}
	type receipt struct {
		Transport   string       `json:"transport"`
		Scenario    string       `json:"scenario"`
		Frames      []string     `json:"frames"`
		Settlements []settlement `json:"settlements"`
		Admissions  int64        `json:"admissions"`
	}
	type scenario struct {
		name       string
		frames     []string
		usage      apikeypolicy.QuotaUsageDelta
		responseID string
	}
	base := apikeypolicy.QuotaUsageDelta{Provider: "codex", Model: "gpt-realtime"}
	usage := func(input, output, total int64) apikeypolicy.QuotaUsageDelta {
		delta := base
		delta.InputTokens, delta.OutputTokens, delta.TotalTokens = input, output, total
		return delta
	}
	buckets := usage(12, 8, 20)
	buckets.ReasoningTokens, buckets.CachedTokens, buckets.CacheReadTokens, buckets.CacheWriteTokens = 3, 4, 4, 2
	buckets.EffectiveServiceTier = "priority"
	tierOnly := base
	tierOnly.EffectiveServiceTier = "priority"
	done := `{"type":"response.done","response":{"id":" duplicate ","usage":{"input_tokens":4,"output_tokens":5,"total_tokens":9}}}`
	scenarios := []scenario{
		{"codex_buckets", []string{`{"type":"response.done","response":{"id":" buckets ","service_tier":"priority","usage":{"input_tokens":12,"output_tokens":8,"input_tokens_details":{"cached_tokens":4,"cache_creation_tokens":2},"output_tokens_details":{"reasoning_tokens":3}}}}`}, buckets, "buckets"},
		{"openai_fallback", []string{`{"type":"response.completed","response":{"id":"fallback"},"usage":{"prompt_tokens":4,"completion_tokens":5,"total_tokens":9}}`}, usage(4, 5, 9), "fallback"},
		{"codex_precedence", []string{`{"type":"response.done","response":{"id":"precedence","usage":{"total_tokens":7}},"usage":{"total_tokens":999}}`}, usage(0, 0, 7), "precedence"},
		{"tier_only_suppresses_fallback", []string{`{"type":"response.done","response":{"id":"tier","service_tier":"priority"},"usage":{"total_tokens":999}}`}, tierOnly, "tier"},
		{"missing_usage", []string{`{"type":"response.completed","response":{"id":"missing"}}`}, base, "missing"},
		{"missing_id", []string{`{"type":"response.done","usage":{"total_tokens":13}}`}, usage(0, 0, 13), ""},
		{"duplicate", []string{done, done}, usage(4, 5, 9), "duplicate"},
		{"nonterminal_then_done", []string{`{broken`, `{"type":"response.done ","usage":{"total_tokens":999}}`, `{"type":"response.output_text.delta"}`, `{"type":"response.completed","response":{"id":"last","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}`}, usage(2, 3, 5), "last"},
	}
	var receipts []receipt
	for _, transport := range []string{"ws", "sideband"} {
		t.Run(transport, func(t *testing.T) {
			var admissions atomic.Int64
			records := make(chan settlement, 32)
			settle := func(ctx context.Context, eventID string, delta apikeypolicy.QuotaUsageDelta) error {
				records <- settlement{eventID, delta, ctx.Err() != nil}
				return errors.New("injected settlement failure")
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			decision := apikeypolicy.RequestPolicyDecision{Mode: apikeypolicy.ModeProfile, Snapshot: &apikeypolicy.RequestPolicySnapshot{
				PolicyID: "policy", ProfileID: "profile", Quota: &apikeypolicy.Quota{Enabled: true, Epoch: 1},
			}}
			ctx = apikeypolicy.WithDecision(ctx, decision)
			ctx = apikeypolicy.WithQuotaAdmission(ctx, func(_ context.Context, decision apikeypolicy.RequestPolicyDecision) (apikeypolicy.RequestPolicyDecision, error) {
				decision.Snapshot.QuotaAdmissionID = fmt.Sprintf("admission-%d", admissions.Add(1))
				decision.Snapshot.QuotaUsageSettlement = settle
				return decision, nil
			})
			upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				for _, test := range scenarios {
					if _, _, err = conn.ReadMessage(); err != nil {
						return
					}
					for _, frame := range test.frames {
						if err = conn.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
							return
						}
					}
				}
				_, _, _ = conn.ReadMessage()
			}))
			defer upstreamServer.Close()
			finished := make(chan struct{})
			downstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(finished)
				upstream, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(upstreamServer.URL, "http"), nil)
				if err != nil {
					return
				}
				upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
				downstream, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					upstream.Close()
					return
				}
				if transport == "ws" {
					_ = relayRealtimeWebsockets(ctx, downstream, upstream, "gpt-realtime")
				} else {
					_ = relaySidebandQuotaWebsockets(ctx, downstream, upstream, liveSession{callID: "receipt_call", quotaModel: "gpt-realtime", quotaSettlement: settle})
				}
			}))
			defer downstreamServer.Close()
			conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(downstreamServer.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			seenWSIDs := map[string]bool{}
			for index, test := range scenarios {
				if err = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create"}`)); err != nil {
					t.Fatal(err)
				}
				for _, frame := range test.frames {
					_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
					_, forwarded, readErr := conn.ReadMessage()
					if readErr != nil || string(forwarded) != frame {
						t.Fatalf("%s frame=%s error=%v", test.name, forwarded, readErr)
					}
				}
				expectedCount := 1
				if transport == "sideband" && test.name == "duplicate" {
					expectedCount = 2
				}
				if transport == "ws" && (test.name == "missing_usage" || test.name == "tier_only_suppresses_fallback") {
					expectedCount = 0
				}
				row := receipt{Transport: transport, Scenario: test.name, Frames: test.frames, Settlements: []settlement{}, Admissions: admissions.Load()}
				for count := 0; count < expectedCount; count++ {
					var record settlement
					select {
					case record = <-records:
					default:
						t.Fatalf("%s missing settlement", test.name)
					}
					if !reflect.DeepEqual(record.Usage, test.usage) || record.Canceled != (transport == "ws") {
						t.Fatalf("%s settlement=%#v expected=%#v", test.name, record, test.usage)
					}
					if transport == "ws" {
						suffix := ""
						if test.responseID != "" {
							suffix = ":response=" + test.responseID
						}
						if !strings.HasPrefix(record.EventID, "realtime:") || !strings.HasSuffix(record.EventID, suffix) || seenWSIDs[record.EventID] {
							t.Fatalf("bad WS ID: %s", record.EventID)
						}
						seenWSIDs[record.EventID] = true
						record.EventID = fmt.Sprintf("realtime:turn=%d%s", index+1, suffix)
					} else {
						wantID := "webrtc:receipt_call:response=" + test.responseID
						if test.responseID == "" {
							wantID = fmt.Sprintf("webrtc:receipt_call:payload=%x", sha256.Sum256([]byte(test.frames[len(test.frames)-1])))
						}
						if record.EventID != wantID {
							t.Fatalf("sideband ID=%s want=%s", record.EventID, wantID)
						}
					}
					row.Settlements = append(row.Settlements, record)
				}
				select {
				case extra := <-records:
					t.Fatalf("%s extra settlement=%#v", test.name, extra)
				default:
				}
				if transport == "ws" && admissions.Load() != int64(index+1) {
					t.Fatalf("%s admissions=%d", test.name, admissions.Load())
				}
				receipts = append(receipts, row)
			}
			_ = conn.Close()
			select {
			case <-finished:
			case <-time.After(3 * time.Second):
				t.Fatal("relay did not stop after disconnect")
			}
			select {
			case extra := <-records:
				t.Fatalf("disconnect manufactured usage=%#v", extra)
			default:
			}
		})
	}
	if destination := os.Getenv("REALTIME_USAGE_RECEIPT"); destination != "" {
		data, err := json.MarshalIndent(receipts, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(destination, append(data, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
}
