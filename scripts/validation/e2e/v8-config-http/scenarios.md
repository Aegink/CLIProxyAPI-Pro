# v8 configuration process-level HTTP scenarios

This validation starts the real Core binary on loopback, reads and writes real
configuration files, and drives the authenticated Management APIs over HTTP.
It never calls an upstream provider.

The failure cases covered are:

1. A legacy YAML file starts, but the existing `/v0/management` contract is no
   longer reachable after the v8 routing change.
2. A v8 YAML file starts, but `/v8/management` and the legacy `/v0/management`
   compatibility surface do not coexist, or the Pro API-key policy service is
   unavailable.
3. Startup writes required Pro usage/panel values to legacy shadow paths, or a
   successful scalar `PUT` through `/v8/management/config/...` rewrites the
   document back to legacy top-level keys or materializes absent fields.
4. A legacy document migrates after its first successful v8 write, but loses
   its client API keys or the Pro API-key policy bindings.
5. A v8 generic save changes API keys from A to B and back to A without
   advancing the Pro configuration generation. An old session-bound `keyRef`
   must be rejected with HTTP 409 even though the final raw key set again
   equals the initial set.

Run all scenarios after building the patched upstream tree:

```sh
python3 scripts/validation/e2e/v8-config-http/run.py \
  --binary /absolute/path/to/cli-proxy-api \
  --output /tmp/v8-config-http-receipt
```

Run only the generation-fence regression while developing its repair:

```sh
python3 scripts/validation/e2e/v8-config-http/run.py \
  --binary /absolute/path/to/cli-proxy-api \
  --output /tmp/v8-config-generation-red \
  --scenario v8_api_key_generation_fence
```

`--output` is a directory. The runner writes `receipt.json` plus one directory
per scenario containing `config.initial.yaml`, the final `config.yaml`,
`server.log`, and a redacted `http-transcript.json`. A failed assertion still
writes the receipt and artifacts, then exits nonzero. Use a fresh output path
for each comparison so failed and repaired receipts remain independently
reviewable.

The assertions intentionally inspect both effective HTTP behavior and the
persisted YAML text. Existing v8 `observability.usage.usage-statistics-enabled`
and `management.panel-github-repository` fields must be updated to the required
Pro values at their nested paths, while scenarios that omit those fields must
keep them absent. This checks the process-level startup/save behavior without
duplicating isolated configuration tests.
