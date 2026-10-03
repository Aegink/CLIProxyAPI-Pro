# Plugin Responses usage failure scenarios

Recorded before changing `plugin_executor_usage.go`.

- A nonstream plugin Responses payload has top-level
  `usage:{input_tokens:34,output_tokens:499,total_tokens:533}`. Reading only
  `response.usage` publishes zero tokens. The selected auth must receive one
  successful nonstream record with the exact 34/499/533 counts.
- Nonstream Responses and Codex responses share the top-level Responses usage
  shape. The same helper must preserve `input_tokens_details.cached_tokens`,
  cache creation/write tokens, `output_tokens_details.reasoning_tokens`, token
  breakdown and top-level `service_tier`, including records carrying only a
  service tier. Do not introduce a separate token normalization algorithm.
- Streamed Responses and Codex terminal events still wrap usage inside
  `response.usage`; switching the stream parser to top-level usage would erase
  counts. Keep their nested parser and terminal success/failure publication.
- The original parser also accepts nested `response.usage` in nonstream plugin
  payloads. Preserve that compatibility when no top-level usage object exists.
  A top-level `service_tier` alone must not suppress nested token parsing;
  choosing the helper by nonzero detail would incorrectly do so. A real
  top-level usage object takes precedence when both locations are present.
- Empty payloads and responses without usage or service tier must not become
  observed usage. Preserve the existing payload extraction and presence check.
- OpenAI Chat Completions, Claude, Gemini, Antigravity and Interactions retain
  their existing format-specific parsers and publication behavior.

## Repeatable final validation

Replay the patch generator against the exact upstream release and run its
existing `internal/pluginhost` regression package. In particular, the upstream
`TestExecutorAdapterExecuteAttributesResponsesUsageToSelectedAuth` exercises
the complete executor adapter and usage-plugin dispatch with the failing
34/499/533 fixture. Preserve verbose output and the upstream commit SHA as a
receipt. Reuse existing stream/cached-token/service-tier helper regressions;
no new unit test is required for already-covered parsing semantics.

Run the existing real-server HTTP usage validation against the final binary:

```sh
python3 scripts/validation/e2e/v8-usage-http/run.py \
  --binary /absolute/path/to/cli-proxy-api \
  --output /private/tmp/plugin-responses-usage-http-final
```

This HTTP runner verifies adjacent host usage persistence and terminal
outcomes. The plugin-specific Responses regression above verifies the changed
adapter path. Keep both receipts; the HTTP runner's binary hash, response,
SQLite rows and usage API response provide a repeatable end artifact.
