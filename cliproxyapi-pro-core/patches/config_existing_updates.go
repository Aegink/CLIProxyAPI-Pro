package config

import (
	"bytes"
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// ExistingScalarUpdate describes one scalar config.yaml value that may be changed only when its full path already exists.
type ExistingScalarUpdate struct {
	Path  []string
	Value any
}

// SaveConfigPreserveCommentsUpdateExistingScalars updates existing scalar paths in one write.
// It never creates a missing key. If any requested path is missing, nothing is written.
func SaveConfigPreserveCommentsUpdateExistingScalars(configFile string, updates []ExistingScalarUpdate) ([]string, error) {
	if len(updates) == 0 {
		return nil, nil
	}
	data, err := os.ReadFile(configFile)
	if err != nil {
		return nil, err
	}
	var root yaml.Node
	if err = yaml.Unmarshal(data, &root); err != nil {
		return nil, err
	}
	if root.Kind != yaml.DocumentNode || len(root.Content) == 0 {
		return nil, fmt.Errorf("invalid yaml document structure")
	}

	targets := make([]*yaml.Node, len(updates))
	missing := make([]string, 0)
	for index, update := range updates {
		target := existingMapPathValue(root.Content[0], update.Path)
		if target == nil {
			missing = append(missing, strings.Join(update.Path, "."))
			continue
		}
		if target.Kind != yaml.ScalarNode {
			return nil, fmt.Errorf("config path %s is not a scalar", strings.Join(update.Path, "."))
		}
		targets[index] = target
	}
	if len(missing) > 0 {
		return missing, nil
	}

	for index, update := range updates {
		var encoded yaml.Node
		if err := encoded.Encode(update.Value); err != nil {
			return nil, err
		}
		target := targets[index]
		target.Kind = encoded.Kind
		target.Tag = encoded.Tag
		target.Value = encoded.Value
		target.Content = encoded.Content
		target.Alias = encoded.Alias
	}

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&root); err != nil {
		_ = enc.Close()
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	data = NormalizeCommentIndentation(buf.Bytes())
	return nil, os.WriteFile(configFile, data, 0o600)
}

func existingMapPathValue(root *yaml.Node, path []string) *yaml.Node {
	if root == nil || len(path) == 0 {
		return nil
	}
	current := root
	for _, key := range path {
		if current == nil || current.Kind != yaml.MappingNode || strings.TrimSpace(key) == "" {
			return nil
		}
		var next *yaml.Node
		for index := 0; index+1 < len(current.Content); index += 2 {
			if current.Content[index] != nil && current.Content[index].Value == key {
				next = current.Content[index+1]
				break
			}
		}
		if next == nil {
			return nil
		}
		current = next
	}
	return current
}

// SaveConfigPreserveCommentsUpdateNestedBoolScalar updates an existing bool scalar without creating missing keys.
func SaveConfigPreserveCommentsUpdateNestedBoolScalar(configFile string, path []string, value bool) error {
	_, err := SaveConfigPreserveCommentsUpdateExistingScalars(configFile, []ExistingScalarUpdate{{Path: path, Value: value}})
	return err
}
