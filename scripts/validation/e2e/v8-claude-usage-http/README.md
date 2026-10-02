# Claude apply_patch and usage HTTP verification

Run against a patched Core server binary:

```sh
python3 scripts/validation/e2e/v8-claude-usage-http/run.py \
  --binary /path/to/cli-proxy-api --output /tmp/claude-usage-http-receipt
```

Use `--scenario` for one case; output must be a new directory. Each case starts
the real server and a loopback upstream, performs one generation request, waits
for usage persistence, stops the server, and checks SQLite for exactly one
durable terminal event. The catalog-only case instead uses Management requests
to configure a policy and verifies the public model catalog.
The receipt includes the binary SHA256, client response, upstream request and
response, SQLite rows, and process logs.

Failure scenarios recorded before the v8.0.9 repair:

- Native Claude JSON success retains its response and observed token detail.
- Responses buffered Claude SSE success retains the custom apply_patch identity
  and exact patch text; malformed arguments return 502 with a failed usage row.
- Responses streaming succeeds exactly once or emits one failed event for
  malformed arguments and incomplete EOF; no success event may follow failure.
- Native apply_patch validation must not publish a zero-token failure before
  Pro publishes its buffered input/output tokens.
- Adjacent OpenAI-compatible nonstream translation follows the same success and
  malformed-argument accounting; streaming incomplete EOF preserves usage.
- Every generation scenario persists exactly one event with the upstream response model
  and all 12 observed tokens, with no retries or late duplicate rows.
- The catalog-only case enables apply_patch and API-key policy takeover through
  Management HTTP, maps an alias to a Claude model, and verifies the alias keeps
  its public ID and the target's executor-backed tool capability. It performs no
  generation request and expects no usage event.

Generator preflight/reapplication and exact upstream/model replay are verified
separately by `scripts/validation/core.sh`.
