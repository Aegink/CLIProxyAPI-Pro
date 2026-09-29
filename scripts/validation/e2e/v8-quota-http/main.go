// Process fixture: real Core routes, manager, host and SQLite; deterministic quota provider.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/api"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/embeddedusage"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/pluginhost"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/access"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

type provider struct {
	calls   atomic.Int64
	entered atomic.Bool
	release chan struct{}
}

func (*provider) Identifier() string { return "fixture" }
func (*provider) DescribeQuota(context.Context, pluginapi.QuotaDescribeRequest) (pluginapi.QuotaDescribeResponse, error) {
	return pluginapi.QuotaDescribeResponse{SupportedProviders: []string{"fixture"}}, nil
}
func (*provider) ResetQuota(context.Context, pluginapi.QuotaResetRequest) (pluginapi.QuotaResetResponse, error) {
	return pluginapi.QuotaResetResponse{}, nil
}
func (p *provider) FetchQuota(ctx context.Context, r pluginapi.QuotaFetchRequest) (pluginapi.QuotaFetchResponse, error) {
	n := p.calls.Add(1)
	if r.Provider == "fail" {
		return pluginapi.QuotaFetchResponse{}, fmt.Errorf("fixture failure")
	}
	if r.Provider == "delay" {
		p.entered.Store(true)
		<-p.release
	}
	if r.AuthProvider != "fixture" || r.AuthID != "fixture-auth" || r.HTTPClient == nil || len(r.StorageJSON) == 0 {
		return pluginapi.QuotaFetchResponse{}, fmt.Errorf("lost auth request context")
	}
	if n > 1 && r.Previous == nil {
		return pluginapi.QuotaFetchResponse{}, fmt.Errorf("lost previous snapshot")
	}
	return pluginapi.QuotaFetchResponse{Subscription: &pluginapi.QuotaSubscription{Plan: "pro", TierID: fmt.Sprintf("tier-%d", n)}, Groups: []pluginapi.QuotaGroup{{Buckets: []pluginapi.QuotaBucket{{Window: "daily", RemainingFraction: 0.75}}}}, AuthUpdate: pluginapi.AuthData{Metadata: map[string]any{"token": fmt.Sprintf("updated-%d", n)}}}, nil
}
func main() {
	root := os.Args[1]
	port, _ := strconv.Atoi(os.Args[2])
	ctx := context.Background()
	os.Setenv("USAGE_DB_PATH", filepath.Join(root, "usage.sqlite"))
	os.Setenv("USAGE_SERVICE_ENABLED", "true")
	svc, err := embeddedusage.Start(ctx)
	if err != nil {
		panic(err)
	}
	embeddedusage.SetDefaultService(svc)
	manager := coreauth.NewManager(nil, nil, nil)
	auth := &coreauth.Auth{ID: "fixture-auth", FileName: "fixture.json", Provider: "fixture", Metadata: map[string]any{"token": "original"}}
	auth.EnsureIndex()
	if _, err = manager.Register(ctx, auth); err != nil {
		panic(err)
	}
	probe := &coreauth.Auth{ID: "probe-auth", FileName: "probe.json", Provider: "probe-fixture", Metadata: map[string]any{"token": "original", "quota_probe": map[string]any{"url": fmt.Sprintf("http://127.0.0.1:%d/fixture/probe", port)}}}
	probe.EnsureIndex()
	if _, err = manager.Register(ctx, probe); err != nil {
		panic(err)
	}
	host := pluginhost.New()
	p := &provider{release: make(chan struct{})}
	host.RegisterPluginForTest("fixture-plugin", pluginapi.Plugin{Capabilities: pluginapi.Capabilities{QuotaProvider: p}})
	cfg := &config.Config{}
	cfg.Host = "127.0.0.1"
	cfg.Port = port
	cfg.AuthDir = filepath.Join(root, "auth")
	os.MkdirAll(cfg.AuthDir, 0700)
	cfg.RemoteManagement.DisableControlPanel = true
	cfg.RemoteManagement.SecretKey = "fixture-key-configured"
	server := api.NewServer(cfg, manager, access.NewManager(), filepath.Join(root, "config.yaml"), api.WithPluginHost(host), api.WithLocalManagementPassword("quota-fixture-key"), api.WithEngineConfigurator(func(e *gin.Engine) {
		e.GET("/fixture/state", func(c *gin.Context) {
			a, _ := manager.GetByID(auth.ID)
			b, _ := manager.GetByID(probe.ID)
			entries, err := embeddedusage.GetQuotaCache(ctx, "", "")
			c.JSON(200, gin.H{"auth_index": auth.Index, "probe_index": probe.Index, "auth": a.Metadata, "probe": b.Metadata, "entries": entries, "cache_error": fmt.Sprint(err), "entered": p.entered.Load()})
		})
		e.GET("/fixture/probe", func(c *gin.Context) {
			c.Data(200, "application/json", []byte(`{"groups":[{"buckets":[{"window":"daily","remainingFraction":0.5}]}],"auth_update":{"Metadata":{"token":"untrusted"}}}`))
		})
		e.POST("/fixture/unload", func(c *gin.Context) {
			host.ShutdownAll()
			host.RegisterPluginForTest("fixture-plugin", pluginapi.Plugin{Capabilities: pluginapi.Capabilities{QuotaProvider: &provider{release: make(chan struct{})}}})
			close(p.release)
			c.JSON(200, gin.H{"ok": true})
		})
	}))
	raw, _ := json.Marshal(map[string]string{"auth_index": auth.Index})
	os.WriteFile(filepath.Join(root, "fixture.json"), raw, 0600)
	if err := server.Start(); err != nil {
		panic(err)
	}
	time.Sleep(time.Second)
}
