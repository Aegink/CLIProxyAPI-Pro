package live

import (
	"encoding/json"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/pro/apikeypolicy"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
)

// realtimeQuotaResponseID recognizes completion frames without changing the
// relay's ownership of response IDs or the active turn's settlement context.
func realtimeQuotaResponseID(payload []byte) (string, bool) {
	var event struct {
		Type     string `json:"type"`
		Response struct {
			ID string `json:"id"`
		} `json:"response"`
	}
	if json.Unmarshal(payload, &event) != nil || (event.Type != "response.done" && event.Type != "response.completed") {
		return "", false
	}
	return event.Response.ID, true
}

// realtimeQuotaUsage decodes provider usage independently of relay admission,
// duplicate handling, event identity and settlement timing.
func realtimeQuotaUsage(payload []byte, model string) apikeypolicy.QuotaUsageDelta {
	detail, ok := helps.ParseCodexUsage(payload)
	if !ok {
		detail = helps.ParseOpenAIUsage(payload)
	}
	totalTokens := detail.TokenBreakdown.TotalTokens
	if totalTokens == 0 {
		totalTokens = detail.TotalTokens
	}
	return apikeypolicy.QuotaUsageDelta{
		Provider: "codex", Model: model, InputTokens: detail.InputTokens,
		OutputTokens: detail.OutputTokens, ReasoningTokens: detail.ReasoningTokens,
		CachedTokens: detail.CachedTokens, CacheReadTokens: detail.CacheReadTokens,
		CacheWriteTokens: detail.CacheCreationTokens, TotalTokens: totalTokens,
		EffectiveServiceTier: detail.ResponseServiceTier, EffectiveSpeed: detail.ResponseSpeed,
	}
}
