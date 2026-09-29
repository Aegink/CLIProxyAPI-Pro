# Quota convergence failure scenarios (written before implementation)

Run a separate Go process using the real API server, auth manager, plugin host and SQLite service. An in-process fixture quota provider is the only mocked external dependency. Python drives actual loopback HTTP and saves full local-only responses plus binary hash in receipt.json.

1. v8 fetch returns only a subset of native fields and fails to persist; v0 and v8 must both return normalized snapshots plus the provider's native `summary`, update auth metadata, persist SQLite, and supply Previous on the next fetch.
2. An explicit missing plugin falls through to declarative quota and incorrectly succeeds; both routes must reject it without changing the cache or auth.
3. Provider-ID and plugin-ID selectors must retain credential identity, Previous, AuthProvider and AuthUpdate. Provider errors preserve the last successful snapshot.
4. A plugin unloaded and reinstalled with the same ID/path/version during a blocked quota call must not commit a late snapshot or AuthUpdate.
5. Declarative fallback remains available without an explicit selector, normalizes native groups and persists; payload AuthUpdate never mutates auth. A summary-only declarative response must preserve `summary` on both routes while the existing snapshot schema remains an empty normalized `items` list.

Policy refresh stays in the one shared production persist function. Reset routes and source/revision protection semantics are excluded. Legacy adapter behavior remains covered by the existing pre-existing host tests; this fixture does not emulate Gemini upstream.

## Repeatable invocation

Use a freshly generated Core tree; the fixture must live under that module to access internal packages. From this repository:

```sh
mkdir -p "$CORE_TREE/cmd/quota-http-fixture"
cp scripts/validation/e2e/v8-quota-http/main.go "$CORE_TREE/cmd/quota-http-fixture/main.go"
(cd "$CORE_TREE" && go build -mod=mod -o /private/tmp/quota-http-fixture ./cmd/quota-http-fixture)
python3 scripts/validation/e2e/v8-quota-http/run.py --binary /private/tmp/quota-http-fixture --output /private/tmp/quota-http-receipt
```

Use a new output directory per run because it contains a real SQLite database. receipt.json records binary SHA-256, HTTP status/body and final outcome; server.log and usage.sqlite remain independently inspectable. The fixture contains synthetic tokens only. It adds no production routes.

## Host API boundary

Pro uses native FetchQuotaByPlugin dispatch after resolving selection. A minimal private record remains necessary to report selected PluginID and enforce host identity; native FetchQuota/FetchQuotaByPlugin return neither that identity nor a generation token. Snapshot-pointer checks before dispatch and after completion reject same-version unload/reload ABA. Any concurrent host snapshot replacement conservatively rejects that fetch; retry obtains current data. Pro still supplies credential-bound HTTP transport, Previous, AuthProvider and bounded AuthUpdate, plus its legacy adapter and normalization/persistence. No new global host epoch is introduced.
