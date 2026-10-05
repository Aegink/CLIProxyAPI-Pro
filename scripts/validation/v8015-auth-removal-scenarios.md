# v8.0.15 Core compatibility validation

## Inputs and failure scenarios (recorded before implementation)

- Failed Actions run: 37245433333; Pro commit: 0a8dd509aab1593f4b2bae2836f1420cd9cbd189.
- Core: v8.0.15, a4acc9f752bd46571f737a10c04bf413656ab06b.
- Models: ff3a6ab4316d31204c90a891ddc1cbbee14d0358.
- Patch generation fails because the old anchor unregisters models before removing auth; v8.0.15 deliberately reverses these operations.
- Restoring the old ordering can let an in-flight refresh adopt the registry tombstone epoch while auth still exists and republish deleted models.
- Omitting Pro policy cleanup leaves stale account policy after deletion.
- Unlocking before removal/registry/policy cleanup allows stale model registration to interleave; omitting unlock blocks later registration/removal.
- Fixing only the first anchor can conceal additional upstream compatibility failures.
- Full replay exposed a second obsolete adaptation: the upstream Antigravity account-catalog test no longer registers `gemini-pro-agent` when it is absent from the fetched catalog. Trying to replace its removed web-search assertion fails generation; retaining the old assertion would conflict with the new account-catalog restriction. Remove only this obsolete adaptation and keep the upstream assertions intact.
- Further replay exposed Claude success-path anchor drift: upstream now remembers OAuth tool aliases after committing continuity in both native and translated streams. Preserve both upstream operations and publish Pro terminal usage afterward; dropping alias retention breaks later tool-name restoration, while dropping terminal publication loses successful usage accounting.
- xAI WebSocket request construction now takes `prepared.finalizePayload`. Preserve this argument and observe the finalized outgoing model; the obsolete one-argument anchor stops generation, and removing finalization would change request payload behavior.
- Auth registration now persists before publication and releases a per-auth mutation lock before scheduler refresh. Restore quota protection before persistence/publication without removing the new I/O checks; preserve `releaseMutation()` when replacing scheduler snapshots, otherwise hooks/refresh may deadlock or serialize unnecessarily.
- The final validator found its old Antigravity hard-timeout/concurrent-base-URL fixture targets tests that upstream replaced with cancellation/first-endpoint tests. Remove the obsolete fixture rather than altering the replacement tests. The ownership inventory shrinks by one upstream-generic test file; synchronize existing inventory assertions with that removal.
- Existing `TestManualCooldownReleaseKeepsIndependentAuthFailure` times out after 25 seconds: `ClearSchedulingBlock` holds `m.mu` and calls `persist`, which now takes `m.mu.RLock`. Acquire the upstream cancellable auth mutation gate and use `persistLocked` on an unpublished clone. A failed save must leave the original cooldown intact; readers/store callbacks must remain usable during I/O; concurrent runtime-only changes must survive publication; stale revisions and replacement accounts must still be rejected. Release the mutation gate before scheduler refresh.

- Full race validation exposed empty model registrations across Codex/Gemini/Meta/Devin/xAI. Upstream inserted `cancelStaleAntigravityProbes` between the context check and disabled-auth check, so an unchecked string replacement silently omitted the Pro registration token. Use a checked replacement, retain probe cancellation, and require existing model registration, deletion/recreation, and policy-filtering regressions to pass.

## Verification

1. Replay the unchanged generator on the exact clean Core revision and retain its failure log.
2. Apply the repaired generator to a fresh checkout with the frozen models data. Inspect generated removal order: generation invalidation under the commit lock, auth removal, registry unregister, policy cleanup, unlock, then probe/session cleanup.
3. Run the complete Core validator with race detection and existing auth/model lifecycle regressions; retain JSONL results and summary. Do not add tests after changing implementation.
4. Run existing inspection HTTP E2E at the end, retaining its repeatable request/response evidence. Check repository contracts and the final diff.

Example (fresh clean checkout required):

```sh
VALIDATION_RACE=1 VALIDATION_INSPECTION_E2E=1 \
VALIDATION_ARTIFACT_DIR=/tmp/ci-v8015-evidence/final4 \
bash scripts/validation/core.sh /tmp/ci-v8015-final4-core /tmp/ci-v8015-models.json
```

## Verified results (2026-10-05)

- Original generator failure: `/tmp/ci-v8015-evidence/before.log`.
- Cold-start replay, patch surface (97 files), rejected reapplication, and `go vet`: passed.
- Full Core race validation: 10,828 test/subtest passes across 45 packages, zero failures; CGO and non-CGO builds passed. Summary and JSONL: `/tmp/ci-v8015-evidence/final4/`.
- The original cooldown test timed out in 25 seconds with `persist` waiting for the read lock. After repair, the existing cooldown and replacement-account regressions passed under race detection. Evidence: `cooldown-isolation.log` and `cooldown-fixed.log` in the evidence directory.
- Existing model registration/deletion/recreation regressions passed under race detection: `model-registration-fixed.log`.
- Inspection HTTP E2E: all 20 receipts passed, no reported coverage gaps; `/tmp/ci-v8015-evidence/final4/inspection-batch-history-e2e/result.json`.
- Claude/translation/usage/catalog HTTP and SQLite E2E: all 10 scenarios passed on the final retained binary; `/tmp/ci-v8015-evidence/claude-http-verified/receipt.json`.
- Repository validation and `git diff --check`: passed. Existing inventory/fixture assertions were synchronized; no new unit tests were added after implementation.
- Inputs, source hashes, final binary, and repair diff are retained under `/tmp/ci-v8015-evidence/`. No commit, push, or release performed.

Repeat the HTTP/SQLite E2E using a new output directory:

```sh
python3 scripts/validation/e2e/v8-claude-usage-http/run.py \
  --binary /tmp/ci-v8015-evidence/cli-proxy-api-verified \
  --output /tmp/ci-v8015-evidence/claude-http-repeat
```
