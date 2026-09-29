# Stream usage HTTP validation

Run after the final Core build:

```sh
python3 scripts/validation/e2e/v8-usage-http/run.py \
  --binary /absolute/path/to/cli-proxy-api \
  --output /private/tmp/v8-usage-http-final
```

The output directory must be new. The runner launches a real Core process and
a loopback OpenAI-compatible upstream for each case: success, failure after
usage, failure before usage, a truncated HTTP body, and a complete HTTP body
without a DONE marker (the native Chat Completions compatibility case). It
checks the final failure flag, response model, token count and single persisted
event through SQLite, and reads the authenticated usage API.

Artifacts include the binary SHA-256, input/final config, upstream SSE/request,
client response, persisted rows, usage API response and server log. All keys are
synthetic fixture values. No external provider is contacted. The isolated helper
regression separately covers buffer-only model observation, which normal
executors can mask with their own observer.
