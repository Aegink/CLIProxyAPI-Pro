# Terminal auth recovery compatibility (before implementation)

Upstream v8.0.12 preserves terminal 401 state even after a successful ordinary
request. Pro also supports explicit, identity-bound recovery. Failure cases:

- The old success-branch patch anchor rejects v8.0.12 before any source writes.
- Updating only the anchor leaves `wasTerminalUnauthorized` true: a successful
  pinned recovery is marked unavailable again at the end of MarkResult.
- Clearing state before verifying the pinned identity/restriction snapshot can
  clear a newer failure, a rotated credential or a replacement registration.
- Treating all successes as recovery lets an ordinary in-flight request erase
  terminal 401 state, undoing the upstream fix.
- Failed pinned probes must retain terminal 401 state.
- The new terminal-refresh failure branch directly upserts the scheduler under
  the manager lock. It must use Pro's policy-aware RefreshSchedulerEntry after
  unlocking, without changing the terminal state or refresh-unschedule behavior.
- clearAuthStateOnSuccess itself now refuses terminal 401 recovery. Only a
  validated pinned success may clear that error before calling the helper.
- Successful pinned recovery must still clear credential/model cooldown while
  preserving quota observations and normal request accounting.

Acceptance: replay the generator against clean v8.0.12 with frozen release
models; run the existing stale identity, concurrent failure and cooldown tests,
plus a pre-implementation terminal-success regression contrasting ordinary and
pinned results. These isolated checks are needed to deterministically inject
the manager's preexisting terminal state. At final validation, run the Core
validation runner and process-level inspection HTTP fixture, retaining JSONL
test events, HTTP receipts, source revisions and binary hashes.
