# Quota persistence

Quota runtime state is persisted by the backend embedded-usage SQLite store. The browser Zustand store is only an in-memory view of that state.

Supported provider maps follow the upstream quota registry: Antigravity, Claude, Codex, Devin,
Gemini CLI, Kimi, Meta, and xAI. The metadata bridge is checked against the upstream quota store
types so a provider cannot be registered without a matching map and setter.

## Flow

1. Provider quota fetchers write successful states to the Zustand quota maps with `cachedAt`.
2. `persistenceMiddleware.ts` observes those maps and writes them through `sqliteQuotaCache.ts`.
3. The backend assigns a monotonically increasing record revision and advances the quota-cache generation on set, delete, clear, or import.
4. The middleware compares generations in `ensureFresh()` and reloads all entries when the backend state changes.
5. Failed writes stay queued and retry with bounded exponential backoff.

Failed reads leave the in-memory view intact and remain retryable. Hydration only suppresses its own synchronous store writes; live refreshes during a network request continue to persist. Older observations cannot replace newer local results, and backend deletion removes only unchanged hydrated values. The existing quota-store generation guards fence file/session invalidation, while stopping the middleware discards queued work and fences outstanding completions.

The API adapter intentionally exposes only list, stats, and write operations used by the middleware. Cache deletion and backup/import remain backend operations.

Account inspection writes directly to the same SQLite cache. Authentication JSON files are not used as a quota-cache store.

For Gemini CLI, normalized Core QuotaProvider snapshots are authoritative. The middleware hydrates those snapshots into the UI shape and does not mirror the same normalized snapshot back as a second legacy cache entry.

Devin and Meta reuse their upstream normalized UI state contracts; credential-bearing provider
responses are already discarded by the upstream fetch adapters before the store is updated. Their
cache rows are not account-policy snapshots; backend policy normalization remains a separate
capability contract.

The cache is included in the usage JSONL export/import format. Imported older revisions do not overwrite newer records.
