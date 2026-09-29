# Devin and Meta quota persistence browser E2E

This harness uses the generated Management `apiClient`, `quotaPersistenceMiddleware`, and
`useQuotaStore` against a disposable loopback Core. It does not replace fetch or API methods and
does not require live Devin or Meta credentials.

The browser writes normalized Devin and Meta success states through the real upstream store
setters, waits until both records are visible from the real SQLite-backed `/usage/quota-cache`,
stops the middleware, clears the store, starts the middleware again, and verifies both records are
restored. Unique records are removed before and after the scenario. The management key is passed
through `page.evaluate` and is not written to the receipt.

1. Apply the Management overlay to a clean checkout and install its locked dependencies.
2. Copy this directory to `<checkout>/e2e/quota-provider-persistence`.
3. Start Vite on loopback, for example `bun run dev -- --host 127.0.0.1 --port 4173`.
4. Start a disposable patched Core with usage SQLite enabled on loopback.
5. Reuse an existing Ego task space and run:

```sh
PRO_E2E_MANAGEMENT_KEY='test-management-key' \
  bash cliproxyapi-pro-management/e2e/quota-provider-persistence/run.sh \
  7 \
  http://127.0.0.1:4173/e2e/quota-provider-persistence/ \
  http://127.0.0.1:8317 \
  /private/tmp/quota-provider-persistence-browser
```

The runner writes `result.json` before attempting `quota-provider-persistence.png`. Screenshot
failure is recorded without discarding a successful HTTP/store receipt. All other failures write a
failed receipt and keep the task space open. Non-loopback Core URLs are rejected.
