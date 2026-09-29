# Quota persistence review

Failure scenarios fixed before implementation (2026-09-26):

- A failed GET must preserve hydrated quota and allow retry at the same backend generation.
- A live quota refresh during GET must remain visible and be persisted; hydration must not suppress it.
- An older persisted observation must not overwrite a newer successful local observation.
- File invalidation or logout during GET must prevent the old response from restoring invalidated data.
- Invalidation while GET is pending must survive completion and trigger the next reload.
- Stop/restart must reject pending hydration, cancel retries, and permit reading a lower generation from another backend.
- Equal timestamps with different payloads must not cause a successful update to be skipped.
- Backend deletion should remove unchanged hydrated state, but preserve locally refreshed state.
- Hydration must not write restored data back; Gemini Core snapshots remain authoritative.

Repeatable focused check after applying the Management overlay:

```sh
bun test tests/quotaPersistence.test.ts
```

This uses the real Zustand store, middleware, normalization and API adapter with controlled API responses. It is an isolated integration regression, not browser or real SQLite E2E coverage.

## Devin and Meta provider coverage

Failure scenarios defined before implementation (2026-09-29):

- The persistence provider list must follow the upstream quota provider registry. Adding a new
  provider to the upstream adapter/store contract must not silently leave Pro persistence behind.
- A successful Devin observation must serialize its whitelisted windows, plan and observation
  timestamps through `/usage/quota-cache`; credential-bearing refresh data must never be present.
- A successful Meta observation must serialize only the normalized `data.windows`, plan name and
  subscription flag through `/usage/quota-cache`; raw Muse response fields must never be present.
- A failed cache write for Devin or Meta must remain queued under the existing bounded retry
  behavior instead of being marked as synchronized.
- After a route/session reload, valid Devin and Meta cache rows must hydrate their upstream Zustand
  maps using the same auth-file cache key that the quota cards use.
- Imported/backup cache rows with incomplete Devin or Meta success shapes must be ignored. A valid
  `quota_cache` row may carry auth identity metadata, but that metadata must not change the UI state
  payload or provider selection.
- Backend deletion must remove unchanged hydrated Devin/Meta state, while a newer live observation
  made after hydration must survive the deletion refresh.
- The existing Antigravity, Claude, Codex, Gemini CLI, Kimi and xAI serialization, hydration,
  generation fencing and Gemini snapshot authority must remain unchanged.
- Devin and Meta cache rows remain UI persistence records only. They must not be treated as
  account-policy snapshots without a separately defined backend normalization contract.

Repeatable focused replay:

```sh
bash scripts/validation/quota_provider_persistence_check.sh \
  /path/to/clean/Cli-Proxy-API-Management-Center \
  /private/tmp/quota-provider-persistence-evidence
```

The runner applies the overlay to an independent temporary copy, executes the focused persistence
and snapshot contract suites, type-checks the generated Management source, and writes logs plus a
machine-readable `result.json` artifact.

## Verification result

- Before implementation: 1 passed, 10 failed (`/private/tmp/quota-persistence-before.log`).
- After implementation: all 11 passed (`/private/tmp/quota-persistence-after.log`).
- Fresh upstream checkout with the overlay: `bun run verify` passed all 1,051 tests, ESLint, TypeScript and the production build (`/private/tmp/quota-persistence-final-validation.log`).
- Management customization checks: all 114 passed (`/private/tmp/quota-persistence-customization.log`).
- Overlay surface check passed; reapplication produced identical source/test contents (`/private/tmp/quota-persistence-replay.txt`).
- Backend persistence was reviewed without modification. Real SQLite and browser E2E were not executed for this change.
