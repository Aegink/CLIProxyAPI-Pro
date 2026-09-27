package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"gopkg.in/yaml.v3"
)

func TestProRequiredStartupConfigLayouts(t *testing.T) {
	for _, tc := range []struct {
		name, source string
		present      bool
	}{
		{"legacy", "usage-statistics-enabled: false\nremote-management: {panel-github-repository: custom}\n", true},
		{"v8", "observability: {usage: {usage-statistics-enabled: false}}\nmanagement: {panel-github-repository: custom}\n", true},
		{"mixed", "usage-statistics-enabled: true\nremote-management: {panel-github-repository: old}\nobservability: {usage: {usage-statistics-enabled: false}}\nmanagement: {panel-github-repository: custom}\n", true},
		{"missing", "server: {port: 8317}\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.yaml")
			if err := os.WriteFile(path, []byte(tc.source), 0600); err != nil {
				t.Fatal(err)
			}
			var cfg config.Config
			if err := yaml.Unmarshal([]byte(tc.source), &cfg); err != nil {
				t.Fatal(err)
			}
			applyProRequiredStartupConfig(&cfg, path)
			if !cfg.UsageStatisticsEnabled || cfg.RemoteManagement.PanelGitHubRepository != config.DefaultPanelGitHubRepository {
				t.Fatalf("runtime settings not enforced: %#v", cfg)
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !tc.present {
				if string(raw) != tc.source {
					t.Fatalf("created missing keys: %s", raw)
				}
				return
			}
			var saved config.Config
			if err := yaml.Unmarshal(raw, &saved); err != nil {
				t.Fatal(err)
			}
			if !saved.UsageStatisticsEnabled || saved.RemoteManagement.PanelGitHubRepository != config.DefaultPanelGitHubRepository {
				t.Fatalf("persisted settings not enforced: %s", raw)
			}
			if tc.name == "v8" && (strings.Contains(string(raw), "remote-management:") || strings.HasPrefix(string(raw), "usage-statistics-enabled:")) {
				t.Fatalf("created legacy spelling: %s", raw)
			}
		})
	}
}
