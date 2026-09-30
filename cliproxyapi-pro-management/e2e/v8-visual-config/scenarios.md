> Historical pre-v1.25.0 adapter scenarios. The latest-only build now uses upstream native v8 editing; see PATCH_MAINTENANCE.md for the current regression contract. Legacy/mixed fallback and byte-identical no-op expectations below no longer apply.

# Visual configuration v8 boundary failures (written before implementation)

Drive the actual `useVisualConfig` hook through the React browser harness. Save its
output through a running Core's authenticated `/v0/management/config.yaml`, then
read `/v0/management/config` and exercise `/v1/models` with old/new client keys.
Keep before/after YAML, HTTP status/body, browser screenshot, and JSON assertions.

1. Canonical client keys appear empty; editing or clearing them overwrites the root
   upstream provider map. All provider groups and their comments must survive.
2. Canonical false/zero/empty values lose to legacy nonzero values in a mixed file.
   Canonical leaf presence wins; missing canonical leaves inherit legacy values.
3. Host/port/TLS/management, requests (proxy, streaming, payload), routing retry,
   multimedia, OAuth, and observability display defaults or write ignored paths.
4. Updating a legacy OAuth provider header in a mixed file accidentally moves it
   into `oauth.providers`, narrowing its scope. Existing legacy-only leaves stay
   legacy; canonical leaves stay OAuth-only. Newly added fields follow file layout.
5. Clearing a canonical field revives an older legacy fallback. Remove ordinary
   fallback paths, but preserve shared legacy OAuth-provider settings and write []
   for cleared canonical OAuth lists. Client-key clearing also explicitly writes [].
6. Canonical map-valued OAuth fields replace the entire legacy map, including {}.
   Nested payload edits drop unknown keys/comments, or partial mixed payload sections
   read one layout but write another. Compare semantic before/after and comments.
7. Legacy-only documents remain editable without unsolicited layout migration.
8. A no-op save changes bytes or materializes defaults. A repeated save changes more
   than the first save. No-op must be byte-identical; reload must show saved values.
9. A valid null section (`routing: null` in v8; `tls`, `plugins`, or `routing` in
   legacy YAML) prevents nested writes and silently discards unrelated edits.
   Keep null byte-identical on no-op, materialize a mapping when edited, retain
   the simultaneous debug edit, and verify a reload remains stable.

Harness: copy this directory into a clean patched Management checkout's `e2e/`.
Start its Vite dev server, open `/e2e/v8-visual-config/`, and use `window.visualV8`:
`load(yaml)`, wait for React, `values()`, `patch({...})`, wait for React, `save()`.
The visible textareas/buttons provide the same operations without private React APIs.
`window.visualV8.receipt()` returns all input/output snapshots for artifacts.

Canonical documents with YAML aliases are explicitly rejected in visual mode to
avoid detaching provider anchors during layout projection; use the raw editor.
Malformed/duplicate-key YAML is rejected before projection. Invalid schema shapes
remain Core's validation responsibility; a failed AST mutation never changes source.

Repeatable browser + optional disposable-Core validation:

```sh
./cliproxyapi-pro-management/e2e/v8-visual-config/run.sh \
  7 http://127.0.0.1:4173/e2e/v8-visual-config/ /private/tmp/visual-v8-green \
  http://127.0.0.1:8317 disposable-management-key
```

The numeric argument is an existing ego task-space ID, not a new space. Omit the
last two arguments for browser-only validation. The HTTP phase restores its initial
YAML in `finally`; use only a disposable loopback process. Artifacts include fixture
secrets and initial YAML, so never point this runner at production.
