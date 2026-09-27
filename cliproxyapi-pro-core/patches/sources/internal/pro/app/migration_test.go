package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	internalconfig "github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/embeddedusage"
	modelconfig "github.com/router-for-me/CLIProxyAPI/v7/internal/pro/oauthpolicy/config"
	proxyconfig "github.com/router-for-me/CLIProxyAPI/v7/internal/pro/proxypool/config"
)

func startMigrationStore(t *testing.T) context.Context {
	t.Helper()
	t.Setenv("USAGE_DB_PATH", filepath.Join(t.TempDir(), "usage.sqlite"))
	t.Setenv("USAGE_SERVICE_ENABLED", "true")
	ctx, cancel := context.WithCancel(context.Background())
	service, err := embeddedusage.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	embeddedusage.SetDefaultService(service)
	t.Cleanup(func() {
		embeddedusage.SetDefaultService(nil)
		cancel()
	})
	return ctx
}

func TestMigrateLegacySettingsPersistsAndCleansYAML(t *testing.T) {
	ctx := startMigrationStore(t)
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	source := `# keep root comment
proxy-url: socks5://127.0.0.1:8318
plugins:
  enabled: true
  configs:
    proxy-pool:
      enabled: true
      priority: 100
      listen: 127.0.0.1:8318
      restore-proxy-url: http://base.example:8080
      nodes:
        - id: one
          url: socks5://proxy.example:1080
          enabled: true
    oauth-model-policy:
      enabled: true
      priority: 10
      providers:
        xai:
          plans:
            free:
              excluded-models: [grok-pro-*]
    third-party:
      enabled: true
      mode: keep
`
	if err := os.WriteFile(configPath, []byte(source), 0o640); err != nil {
		t.Fatal(err)
	}
	migrated, err := migrateLegacySettings(ctx, configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !migrated || baseProxyURLFromConfigFile(configPath, "socks5://127.0.0.1:8318") != "http://base.example:8080" {
		t.Fatal("migration did not restore the in-memory base proxy value")
	}
	if migratedAgain, err := migrateLegacySettings(ctx, configPath); err != nil {
		t.Fatalf("second migration is not idempotent: %v", err)
	} else if migratedAgain {
		t.Fatal("second migration unexpectedly rewrote config.yaml")
	}
	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if strings.Contains(text, "proxy-pool:") || strings.Contains(text, "oauth-model-policy:") {
		t.Fatalf("legacy feature config remains:\n%s", text)
	}
	if !strings.Contains(text, "plugins:") || !strings.Contains(text, "enabled: true") || !strings.Contains(text, "third-party:") || !strings.Contains(text, "mode: keep") {
		t.Fatalf("third-party config was not preserved:\n%s", text)
	}
	if !strings.Contains(text, "proxy-url: http://base.example:8080") || !strings.Contains(text, "# keep root comment") {
		t.Fatalf("base proxy or comment was not restored:\n%s", text)
	}
	proxyItem, found, err := embeddedusage.GetProSetting(ctx, embeddedusage.ProSettingNamespaceProxyPool)
	if err != nil || !found {
		t.Fatalf("proxy setting = found:%v err:%v", found, err)
	}
	proxyCfg, err := proxyconfig.Parse(proxyItem.Settings)
	if err != nil || !proxyCfg.Enabled || !proxyCfg.TakeoverEnabled || len(proxyCfg.Nodes) != 1 {
		t.Fatalf("proxy config = %#v err:%v", proxyCfg, err)
	}
	modelItem, found, err := embeddedusage.GetProSetting(ctx, embeddedusage.ProSettingNamespaceOAuthPolicy)
	if err != nil || !found {
		t.Fatalf("model setting = found:%v err:%v", found, err)
	}
	modelCfg, err := modelconfig.Parse(modelItem.Settings)
	if err != nil || !modelCfg.Enabled || len(modelCfg.Providers) != 1 {
		t.Fatalf("model config = %#v err:%v", modelCfg, err)
	}
}

func TestMigrateLegacySettingsKeepsExistingSQLiteValue(t *testing.T) {
	ctx := startMigrationStore(t)
	existing, err := proxyconfig.Parse([]byte(`{"enabled":false,"listen":"127.0.0.1:8318"}`))
	if err != nil {
		t.Fatal(err)
	}
	existingRaw, err := proxyconfig.Marshal(existing)
	if err != nil {
		t.Fatal(err)
	}
	if err := persistSetting(ctx, embeddedusage.ProSettingNamespaceProxyPool, existingRaw); err != nil {
		t.Fatal(err)
	}

	configPath := filepath.Join(t.TempDir(), "config.yaml")
	source := `proxy-url: socks5://127.0.0.1:8318
plugins:
  enabled: true
  configs:
    proxy-pool:
      enabled: true
      listen: 127.0.0.1:8318
      restore-proxy-url: http://base.example:8080
      nodes:
        - id: stale
          url: socks5://stale.example:1080
          enabled: true
`
	if err := os.WriteFile(configPath, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := migrateLegacySettings(ctx, configPath); err != nil {
		t.Fatal(err)
	}
	stored, found, err := embeddedusage.GetProSetting(ctx, embeddedusage.ProSettingNamespaceProxyPool)
	if err != nil || !found {
		t.Fatalf("stored setting = found:%v err:%v", found, err)
	}
	if string(stored.Settings) != string(existingRaw) {
		t.Fatalf("existing SQLite setting was overwritten: got %s want %s", stored.Settings, existingRaw)
	}
	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "proxy-pool:") || !strings.Contains(string(raw), "proxy-url: http://base.example:8080") {
		t.Fatalf("legacy YAML was not cleanly retired:\n%s", raw)
	}
}

func TestRuntimeUsesRestoredBaseProxyDuringMigrationStartup(t *testing.T) {
	for _, tc := range []struct {
		name, prefix, restore, want string
		modelOnly                   bool
	}{
		{"legacy", "proxy-url: socks5://127.0.0.1:8318\n", "http://base.example:8080", "http://base.example:8080", false},
		{"v8", "requests: {proxy-url: socks5://127.0.0.1:8318}\n", "http://base.example:8080", "http://base.example:8080", false},
		{"v8-empty-restore", "proxy-url: socks5://127.0.0.1:8318\nrequests: {proxy-url: socks5://127.0.0.1:8318}\n", "", "", false},
		{"v8-explicit-empty", "proxy-url: socks5://127.0.0.1:8318\nrequests: {proxy-url: ''}\n", "http://base.example:8080", "", false},
		{"v8-model-only", "requests: {proxy-url: http://base.example:8080}\n", "", "http://base.example:8080", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := startMigrationStore(t)
			configPath := filepath.Join(t.TempDir(), "config.yaml")
			source := tc.prefix + "plugins:\n  configs:\n    proxy-pool:\n      enabled: false\n      listen: 127.0.0.1:8318\n      restore-proxy-url: '" + tc.restore + "'\n"
			if tc.modelOnly {
				source = tc.prefix + "plugins:\n  configs:\n    oauth-model-policy: {enabled: true, providers: {}}\n"
			}
			if err := os.WriteFile(configPath, []byte(source), 0600); err != nil {
				t.Fatal(err)
			}
			runtime, err := New(ctx, configPath, "socks5://127.0.0.1:8318")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(runtime.Close)
			if got := runtime.BaseProxyURL(); got != tc.want {
				t.Errorf("runtime base proxy = %q, want %q", got, tc.want)
			}
			saved, err := internalconfig.LoadConfig(configPath)
			if err != nil {
				t.Fatal(err)
			}
			if saved.ProxyURL != tc.want {
				t.Errorf("reloaded proxy = %q, want %q", saved.ProxyURL, tc.want)
			}
			if !tc.modelOnly {
				item, found, err := embeddedusage.GetProSetting(ctx, embeddedusage.ProSettingNamespaceProxyPool)
				if err != nil || !found {
					t.Fatalf("proxy migration missing: %v", err)
				}
				cfg, err := proxyconfig.Parse(item.Settings)
				if err != nil {
					t.Fatal(err)
				}
				if cfg.TakeoverEnabled != (tc.name != "v8-explicit-empty") {
					t.Errorf("takeover = %v", cfg.TakeoverEnabled)
				}
			}
			if changed, err := migrateLegacySettings(ctx, configPath); err != nil || changed {
				t.Fatalf("not idempotent: %v %v", changed, err)
			}
		})
	}
}

func TestMigrateLegacySettingsLeavesInvalidYAMLUntouched(t *testing.T) {
	ctx := startMigrationStore(t)
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	source := `plugins:
  configs:
    proxy-pool:
      enabled: true
      listen: 0.0.0.0:8318
`
	if err := os.WriteFile(configPath, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := migrateLegacySettings(ctx, configPath); err == nil {
		t.Fatal("migration error = nil, want invalid loopback listener error")
	}
	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != source {
		t.Fatalf("invalid migration changed YAML:\n%s", raw)
	}
	if _, found, err := embeddedusage.GetProSetting(ctx, embeddedusage.ProSettingNamespaceProxyPool); err != nil || found {
		t.Fatalf("invalid migration persisted setting = found:%v err:%v", found, err)
	}
}

func TestMigrateLegacySettingsRemovesEmptyPluginsSection(t *testing.T) {
	ctx := startMigrationStore(t)
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	source := `host: 127.0.0.1
plugins:
  configs:
    oauth-model-policy:
      enabled: true
      providers: {}
`
	if err := os.WriteFile(configPath, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := migrateLegacySettings(ctx, configPath); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(configPath)
	if strings.Contains(string(raw), "plugins:") {
		t.Fatalf("empty plugins section remains:\n%s", raw)
	}
}
