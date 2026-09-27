# v8 configuration persistence and migration scenarios

Failures to reproduce before implementation:

- Startup receives explicit disabled usage and a custom panel repository in a v8 document: memory is enforced but existing nested YAML values remain stale.
- Legacy and v8 spellings coexist: the v8 value must win, and startup must update the effective existing spelling.
- Neither spelling exists: startup must not create settings.
- Legacy proxy-pool settings coexist with `requests.proxy-url`: migration must recognize takeover, restore the base URL in the same layout, and persist the takeover flag to SQLite.
- A migrated OAuth policy alone must not erase the v8 base proxy URL in the running application.
- An explicitly empty v8 proxy URL must win over a stale legacy proxy URL.
- An empty restore URL must remove both effective and shadowed old proxy values, so reload cannot resurrect the pool endpoint.

Repeat after applying patches to a disposable v8 checkout:

```sh
go test -json ./internal/cmd -run TestProRequiredStartupConfigLayouts -count=1 > startup-config.jsonl
go test -json ./internal/pro/app -run 'TestRuntimeUsesRestoredBaseProxyDuringMigrationStartup|TestMigrateLegacySettings' -count=1 > migration-config.jsonl
```

Preserve the JSONL logs as the repeatable validation receipt. These focused tests exercise config files, upstream config decoding, application startup, and the actual SQLite migration store; run the complete validation only after development.
