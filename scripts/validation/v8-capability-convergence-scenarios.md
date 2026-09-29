# v8 capability convergence: failure scenarios

Record failure evidence before changing the implementation. Run focused cases
during development and the full validation/E2E runs only after integration.

## Failed usage and upstream ownership

- A stream buffer observes a response model without token usage, then fails:
  publish a failed zero-token event and retain that response model.
- A stream buffer observes model, input/cache tokens and speed before a failure:
  publish the observed details and model once, without requiring the executor to
  separately notify the reporter of the model.
- A reporter already has an authoritative response model: buffer fallback must
  not replace it.
- Nil buffer/reporter must remain safe and report that nothing was published.
- OpenAI/Claude streaming errors, upstream disconnects and client cancellation
  must retain the failure outcome and previously observed token usage.
- Removing absorbed Claude nested-usage parsing and failure-detail insertion
  patches must leave those upstream behaviors intact.

The isolated buffer cases are necessary because production executors may also
observe the model directly, masking a broken buffer fallback. Establish these
cases in the existing helper test before retiring the replacement. Keep JSONL
red/green output. Use process-level HTTP requests and persisted usage receipts
for the final stream behavior validation.

## Integration boundaries

- Canonical v8 visual config edits must preserve upstream credential groups and
  update client access keys, not replace the upstream `api-keys` map.
- Legacy, canonical and mixed config layouts must retain effective precedence,
  comments and OAuth-only versus shared provider scope.
- v0 and v8 quota fetch must share auth update, quota persistence and policy
  refresh behavior without changing reset/recovery authorization semantics.
- Native quota selection must preserve explicit plugin isolation, provider
  override, previous snapshots, auth updates and unload-generation checks.
- Devin/Meta quota snapshots must survive reload with the same provider shape;
  existing provider snapshots and backup formats must remain compatible.

Each subsystem's E2E runner records exact inputs and results in its output
directory. The final receipt must identify upstream and Pro revisions and link
the config, HTTP, persisted-state and browser artifacts used for verification.
