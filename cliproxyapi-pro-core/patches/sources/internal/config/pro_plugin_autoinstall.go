package config

import sdkpluginstore "github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginstore"

// PluginAutoInstallProxyURL returns the proxy URL used by plugin store auto-install requests.
func (cfg *Config) PluginAutoInstallProxyURL() string {
	if cfg == nil {
		return ""
	}
	return cfg.ProxyURL
}

// PluginAutoInstallEnabled reports whether dynamic plugins are enabled.
func (cfg *Config) PluginAutoInstallEnabled() bool {
	return cfg != nil && cfg.Plugins.Enabled
}

// PluginAutoInstallDir returns the normalized plugin discovery directory.
func (cfg *Config) PluginAutoInstallDir() string {
	if cfg == nil {
		return ""
	}
	return cfg.Plugins.Dir
}

// PluginAutoInstallStoreSources returns configured third-party plugin registry URLs.
func (cfg *Config) PluginAutoInstallStoreSources() []string {
	if cfg == nil || len(cfg.Plugins.StoreSources) == 0 {
		return nil
	}
	return append([]string(nil), cfg.Plugins.StoreSources...)
}

// PluginAutoInstallEnabledIDs returns configured plugin IDs that should be present at startup.
func (cfg *Config) PluginAutoInstallEnabledIDs() []string {
	if cfg == nil || len(cfg.Plugins.Configs) == 0 {
		return nil
	}
	ids := make([]string, 0, len(cfg.Plugins.Configs))
	for id, item := range cfg.Plugins.Configs {
		if item.Enabled == nil || !*item.Enabled {
			continue
		}
		ids = append(ids, id)
	}
	return ids
}

// PluginAutoInstallStoreAuth returns normalized plugin store authentication rules.
func (cfg *Config) PluginAutoInstallStoreAuth() []sdkpluginstore.AuthConfig {
	if cfg == nil || len(cfg.Plugins.StoreAuth) == 0 {
		return nil
	}
	return append([]sdkpluginstore.AuthConfig(nil), cfg.Plugins.StoreAuth...)
}
