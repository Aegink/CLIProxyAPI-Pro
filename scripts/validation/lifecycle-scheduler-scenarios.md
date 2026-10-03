# Lifecycle scheduler snapshot compatibility (before implementation)

The v8.0.13 release moves Register/updateInternal scheduler snapshots under the
manager lock. Failure cases to preserve when adapting the Pro generator:

- The old two-upsert anchor matches neither new call and rejects the entire
  patch before writes. Reproduce against d7914afdedca7af95ee974a42453dc49fc1388ce
  with models 53b3d7ed832428f9cb64a71e1acec9d7177c6cf8.
- Replacing only the upsert leaves an unused schedulerSnapshot local and fails
  compilation. Remove its now-redundant construction as part of the same anchor.
- Keeping a direct upsert bypasses the execution-only account-policy overlay.
  Both Register and updateInternal must call RefreshSchedulerEntry after unlock.
- Moving RefreshSchedulerEntry under m.mu deadlocks on its RLock; cloning a
  published auth outside the lock reintroduces the upstream MarkResult race.
- Dropping either refresh leaves registration or update scheduler state stale.
- A partial or changed upstream anchor must still fail before source writes;
  rejected reapplication must leave the customized tree unchanged.

Acceptance: use the existing account-policy lifecycle checks and upstream
TestPublishedAuthSnapshotRace (Register, Update, UpdatePreparedAuth and
UpdateRefreshedAuth) to inject concurrent MarkResult operations. No new unit
tests are needed. After implementation, replay the complete Core validator with
VALIDATION_RACE=1 and VALIDATION_INSPECTION_E2E=1 on a clean fixed-SHA checkout.
Retain pre-fix failure, JSONL race results, CGO/non-CGO build results, inspection
HTTP result.json, source/model hashes and the applied diff in an artifact folder.

Repeat with:

```sh
VALIDATION_ARTIFACT_DIR=<output>/core VALIDATION_RACE=1 \
VALIDATION_INSPECTION_E2E=1 bash scripts/validation/core.sh \
  <clean-v8.0.13-checkout> <frozen-models.json>
bash scripts/validation/repo.sh
```
