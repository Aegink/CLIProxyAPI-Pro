# v8.0.24 authentication context replay

## Failure scenarios recorded before implementation

- Exact upstream `091ff27f31285ec4fd1dd5823b44f7f51fb8f48b` adds usage context to successful authentication. The previous whole-block anchor matches zero times.
- Dropping WithAPIKey, WithAccessProvider, WithIsNativeKey, or the request context assignment breaks upstream usage identity propagation.
- Policy identity and decision must derive from the request context after the usage assignment, preserving both context families.
- Native-provider and non-nil-policy guards, policy-error returns, metadata handling, nil-result behavior, and c.Next must remain intact.
- Reapplying this block must leave it byte-identical with exactly one policy injection.
- Missing, duplicate, mixed old/new, or duplicate already-patched blocks must fail without queuing a write.

## Repeatable validation

Run `python3 scripts/validation/test_auth_context_patch_contract.py`. It executes the actual generator operation and helpers against the exact upstream success block and malformed variants. Retain stdout with final validation artifacts. This bounded contract does not replace final clean exact-upstream replay, Go validation, and HTTP E2E.

## Redis queue follow-up drift (recorded before its repair)

- Complete replay exposes two more exact anchors changed by upstream: queuedUsageDetail construction and its type now include IsNativeKey and AccessProvider between APIKey and RequestID.
- Preserve both native-key fields and their JSON tags; removing either loses the attribution captured by the upstream auth context.
- Keep all six Pro policy attribution fields in the payload and type exactly once, in addition to the upstream fields.
- Missing, duplicated, partially patched, or mixed old/new anchors must fail without writes. Replaying either operation must preserve bytes.
- Run `python3 scripts/validation/test_redisqueue_identity_patch_contract.py` before and after repair, then replay the complete generator against a private clean clone of the exact upstream revision before final integrated validation.

## Codex catalog compilation drift (recorded before its repair)

- Full Go validation exposes the newly required ToolSearchCapabilityForModel callback in BuildResponseForClientWithToolCapabilities; the Pro replacement still emits the old call signature.
- Supplying nil only to compile would silently disable upstream Claude search capability. Preserve ClientToolSearchEnabled gating and SupportsNativeToolSearchModel behavior.
- Looking up capabilities by public policy alias rather than EffectiveID can advertise the wrong capability or suppress supported search. Resolve the effective model consistently with existing provider, web-search, and apply-patch callbacks.
- Preserve the frozen request policy model list, client version, multi-agent option, and apply-patch option.
- Before changing the implementation, add the catalog generator contract; afterward run it, clean full replay, and the existing openai handler package tests (including upstream switch/capability tests). Final integrated HTTP E2E remains the main-session responsibility.
