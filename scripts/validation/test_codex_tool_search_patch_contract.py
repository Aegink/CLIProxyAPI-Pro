"""v8.0.24 catalog callback regression contract, authored before repair."""
import ast
import unittest
from pathlib import Path

PATCHER = Path(__file__).resolve().parents[2] / 'cliproxyapi-pro-core/patches/apply_upstream_patches.py'


class CodexToolSearchPatchContract(unittest.TestCase):
    def test_policy_catalog_preserves_gated_effective_model_search_callback(self):
        tree = ast.parse(PATCHER.read_text())
        replacements = [n.value.args[2].value for n in tree.body
                        if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)
                        and len(n.value.args) >= 3 and isinstance(n.value.args[0], ast.Name)
                        and n.value.args[0].id == 'openai_handlers_source'
                        and isinstance(n.value.args[2], ast.Constant)
                        and 'BuildResponseForClientWithToolCapabilities' in str(n.value.args[2].value)]
        self.assertEqual(len(replacements), 1)
        replacement = replacements[0]
        self.assertIn('var toolSearchCapabilityForModel codexmodels.ToolSearchCapabilityForModelFunc', replacement)
        self.assertIn('''if responsesclaude.ClientToolSearchEnabled() {
\t\t\ttoolSearchCapabilityForModel = func(id string) bool {
\t\t\t\treturn h.SupportsNativeToolSearchModel(effectiveModelID(id))
\t\t\t}
\t\t}''', replacement)
        self.assertIn('BuildResponseForClientWithToolCapabilities(allModels, providersForModel, webSearchCapabilityForModel, applyPatchCapabilityForModel, toolSearchCapabilityForModel, h.Cfg != nil && h.Cfg.Client.Codex.OptimizeMultiAgentV2, clientVersion)', replacement)
        self.assertIn('effectiveIDs[model.ID] = model.EffectiveID', replacement)
        self.assertIn('handlers.FilterModelsForRequest(c.Request.Context(), catalogIDs, modelRegistry.GetModelProviders)', replacement)
        self.assertIn('h.Cfg != nil && h.Cfg.Client.Codex.EnableApplyPatch', replacement)


if __name__ == '__main__':
    unittest.main()
