# QuotaProvider plugin protocol

`QuotaProvider` is an upstream optional plugin capability. Pro reuses native host dispatch,
panic isolation and transport lifecycle, and adds normalized snapshots, persistence,
last-known-good plans and legacy Gemini CLI compatibility.

## Capability and methods

Plugins advertise `quota_provider: true` in `plugin.register` and implement:

- `quota.identifier` -> `{ "identifier": "gemini-cli" }`
- `quota.fetch` -> `pluginapi.QuotaFetchResponse`

Adding these method names is backward compatible with ABI/schema v1. Hosts ignore the capability
when it is absent, and older plugins continue to register normally.

The fetch request contains the concrete auth ID/provider, provider-owned storage JSON, metadata,
attributes, the previous normalized snapshot, host configuration, and a host HTTP callback. A
plugin must use the callback for upstream requests; it must not expose access tokens or endpoint
credentials in the returned snapshot.

## Normalized snapshot v1

The host persists `QuotaSnapshot` rather than provider response bodies. Its stable fields are:

- `schema_version`, `provider`, and `observed_at_ms`
- `items[]`: stable `id`, display `label`, kind, remaining fraction/amount, limit/unit, reset time,
  represented model IDs, and non-secret metadata
- optional `plan`: provider tier ID/label, normalized kind, credit balance, and observation state
- non-fatal `warnings[]` and non-secret snapshot metadata

Fractions are normalized to `0..1` and used percentages to `0..100`. A plugin returning a schema
newer than the host supports is rejected instead of being silently persisted.

## Partial success and last-known-good plan

Quota and plan probes may have different availability. When the primary quota probe succeeds but
the plan probe fails, the plugin returns the new items with `plan_unavailable: true` and a
non-secret `plan_error`. The host retains the previous plan, marks it stale, records the error, and
persists the combined snapshot. A transient plan failure therefore cannot erase a previously known
subscription.

## Gemini CLI Core compatibility adapter

The current Gemini CLI plugin does not need to implement or advertise this capability. When no
native `QuotaProvider` matches `gemini-cli`, Core recognizes the plugin's existing executor and uses
its `Executor.HttpRequest` for:

- `POST .../v1internal:retrieveUserQuota` as the primary observation
- `POST .../v1internal:loadCodeAssist` as the supplementary plan observation

This preserves the plugin's authentication injection, token refresh, proxy path, and request
fingerprint. Core only owns quota/plan parsing. Gemini model buckets are collapsed into stable
Flash Lite, Flash, and Pro groups. Gemini 2.0 Flash buckets are ignored. Tier parsing tolerates the
response wrappers used by older management bridges. `paidTier` wins when it has an ID; otherwise
`currentTier` is used, followed by the default entry in `allowedTiers`. A successful response with
no supported tier is treated as a partial plan failure, so the previous persisted plan is retained
as stale instead of being erased. Tier IDs are normalized as follows: `free-tier -> free`,
`legacy-tier -> legacy`, `standard-tier -> standard`, `g1-pro-tier -> pro`, and
`g1-ultra-tier -> ultra`.

## Management and persistence

`POST /v0/management/quota/fetch` and `POST /v8/management/credentials/quota/fetch`
share one handler and accept `{ "auth_index": "..." }`. Explicit `plugin_id` or a different
`provider` selection never falls back to the credential's local declarative probe.
The host resolves the auth,
loads its previous snapshot from SQLite, invokes the matching plugin, applies any auth refresh,
persists the normalized snapshot, and returns it. The browser is a reader of this canonical record.

The management overlay uses the host endpoint on current Core releases. It falls back to the old
browser bridge only when connected to a Core version where that route does not exist. `/plugins`
reports `quota_mode: legacy-adapter` for the current Gemini plugin and `quota_mode: native` when a
future plugin implements `QuotaProvider`; native capability always wins.
