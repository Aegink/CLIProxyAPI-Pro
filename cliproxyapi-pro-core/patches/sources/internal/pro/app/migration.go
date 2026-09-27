package app

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	internalconfig "github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	modelconfig "github.com/router-for-me/CLIProxyAPI/v7/internal/pro/oauthpolicy/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/pro/observability"
	proxyconfig "github.com/router-for-me/CLIProxyAPI/v7/internal/pro/proxypool/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/pro/settings"
	"gopkg.in/yaml.v3"
)

const (
	legacyProxyPoolID        = "proxy-pool"
	legacyOAuthModelPolicyID = "oauth-model-policy"
)

func migrateLegacySettings(ctx context.Context, configFilePath string) (bool, error) {
	configFilePath = strings.TrimSpace(configFilePath)
	if configFilePath == "" {
		return false, nil
	}
	data, err := os.ReadFile(configFilePath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return false, err
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) == 0 || document.Content[0].Kind != yaml.MappingNode {
		return false, fmt.Errorf("invalid config.yaml document structure")
	}
	root := document.Content[0]
	proxyMapping := configProxyMapping(root)
	plugins := mapValue(root, "plugins")
	configs := mapValue(plugins, "configs")
	legacyProxy := mapValue(configs, legacyProxyPoolID)
	legacyModel := mapValue(configs, legacyOAuthModelPolicyID)
	if legacyProxy == nil && legacyModel == nil {
		return false, nil
	}

	var proxyCfg proxyconfig.Config
	var restoreProxyURL string
	if legacyProxy != nil {
		raw, errMarshal := yaml.Marshal(legacyProxy)
		if errMarshal != nil {
			return false, errMarshal
		}
		proxyCfg, err = proxyconfig.Parse(raw)
		if err != nil {
			return false, err
		}
		restoreProxyURL = scalarMapValue(legacyProxy, "restore-proxy-url")
		if isProxyPoolURL(scalarMapValue(proxyMapping, "proxy-url"), proxyCfg.Listen) {
			proxyCfg.TakeoverEnabled = true
		}
		if err := migrateSettingIfMissing(ctx, settings.NamespaceProxyPool, func() ([]byte, error) {
			return proxyconfig.Marshal(proxyCfg)
		}); err != nil {
			return false, err
		}
	}
	if legacyModel != nil {
		raw, errMarshal := yaml.Marshal(legacyModel)
		if errMarshal != nil {
			return false, errMarshal
		}
		modelCfg, errParse := modelconfig.Parse(raw)
		if errParse != nil {
			return false, errParse
		}
		if err := migrateSettingIfMissing(ctx, settings.NamespaceOAuthPolicy, func() ([]byte, error) {
			return modelconfig.Marshal(modelCfg)
		}); err != nil {
			return false, err
		}
	}

	if legacyProxy != nil && isProxyPoolURL(scalarMapValue(proxyMapping, "proxy-url"), proxyCfg.Listen) {
		// A removed v8 value must not expose a shadowed legacy pool endpoint.
		if proxyMapping != root {
			removeMapKey(root, "proxy-url")
		}
		if strings.TrimSpace(restoreProxyURL) == "" {
			removeMapKey(proxyMapping, "proxy-url")
		} else {
			setMapScalar(proxyMapping, "proxy-url", restoreProxyURL)
		}
	}
	removeMapKey(configs, legacyProxyPoolID)
	removeMapKey(configs, legacyOAuthModelPolicyID)
	if configs != nil && len(configs.Content) == 0 {
		removeMapKey(plugins, "configs")
	}
	if plugins != nil && len(plugins.Content) == 0 {
		removeMapKey(root, "plugins")
	}
	if err := writeYAMLAtomically(configFilePath, &document); err != nil {
		return false, err
	}
	return true, nil
}

func baseProxyURLFromConfigFile(configFilePath, fallback string) string {
	data, err := os.ReadFile(strings.TrimSpace(configFilePath))
	if err != nil {
		return strings.TrimSpace(fallback)
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil || document.Kind != yaml.DocumentNode || len(document.Content) == 0 {
		return strings.TrimSpace(fallback)
	}
	root := document.Content[0]
	if root.Kind != yaml.MappingNode {
		return strings.TrimSpace(fallback)
	}
	if value := mapValue(configProxyMapping(root), "proxy-url"); value != nil && value.Kind == yaml.ScalarNode {
		return strings.TrimSpace(value.Value)
	}
	return ""
}

// Presence gives v8 precedence even when its proxy URL is explicitly empty.
func configProxyMapping(root *yaml.Node) *yaml.Node {
	requests := mapValue(root, "requests")
	if mapValue(requests, "proxy-url") != nil {
		return requests
	}
	return root
}

func migrateSettingIfMissing(ctx context.Context, namespace string, encode func() ([]byte, error)) error {
	store := observability.NewSettingsStore()
	if _, found, err := store.Get(ctx, namespace); err != nil {
		return err
	} else if found {
		return nil
	}
	raw, err := encode()
	if err != nil {
		return err
	}
	if err := persistSetting(ctx, namespace, raw); err != nil {
		return err
	}
	stored, found, err := store.Get(ctx, namespace)
	if err != nil {
		return err
	}
	if !found || stored.SchemaVersion != settings.SchemaVersionOne || !bytes.Equal(bytes.TrimSpace(stored.Settings), bytes.TrimSpace(raw)) {
		return fmt.Errorf("verify migrated Pro setting %q failed", namespace)
	}
	return nil
}

func persistSetting(ctx context.Context, namespace string, raw []byte) error {
	return observability.NewSettingsStore().Put(ctx, settings.Item{
		Namespace: namespace, SchemaVersion: settings.SchemaVersionOne, Settings: raw,
	})
}

func mapValue(mapping *yaml.Node, key string) *yaml.Node {
	if mapping == nil || mapping.Kind != yaml.MappingNode {
		return nil
	}
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index] != nil && mapping.Content[index].Value == key {
			return mapping.Content[index+1]
		}
	}
	return nil
}

func scalarMapValue(mapping *yaml.Node, key string) string {
	value := mapValue(mapping, key)
	if value == nil || value.Kind != yaml.ScalarNode {
		return ""
	}
	return strings.TrimSpace(value.Value)
}

func removeMapKey(mapping *yaml.Node, key string) {
	if mapping == nil || mapping.Kind != yaml.MappingNode {
		return
	}
	for index := 0; index+1 < len(mapping.Content); index += 2 {
		if mapping.Content[index] != nil && mapping.Content[index].Value == key {
			mapping.Content = append(mapping.Content[:index], mapping.Content[index+2:]...)
			return
		}
	}
}

func setMapScalar(mapping *yaml.Node, key, value string) {
	if mapping == nil || mapping.Kind != yaml.MappingNode {
		return
	}
	if existing := mapValue(mapping, key); existing != nil {
		existing.Kind = yaml.ScalarNode
		existing.Tag = "!!str"
		existing.Value = value
		existing.Content = nil
		return
	}
	mapping.Content = append(mapping.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value},
	)
}

func isProxyPoolURL(raw, listen string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return false
	}
	return (parsed.Scheme == "socks5" || parsed.Scheme == "socks5h") && strings.EqualFold(parsed.Host, strings.TrimSpace(listen))
}

func writeYAMLAtomically(path string, document *yaml.Node) error {
	var buffer bytes.Buffer
	encoder := yaml.NewEncoder(&buffer)
	encoder.SetIndent(2)
	if err := encoder.Encode(document); err != nil {
		_ = encoder.Close()
		return err
	}
	if err := encoder.Close(); err != nil {
		return err
	}
	data := internalconfig.NormalizeCommentIndentation(buffer.Bytes())
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".config.yaml.pro-migration-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(info.Mode().Perm()); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
