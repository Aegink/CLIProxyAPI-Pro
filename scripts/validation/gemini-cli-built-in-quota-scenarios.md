# Gemini CLI built-in quota regression scenarios

Recorded before the repair for Management v1.26.1 (`390718ecfec90b674fed474862e497522273e129`), Actions run `38093913297`.

1. The generated quota tab list includes `gemini-cli`, but the upstream `BUILT_IN_QUOTA_PROVIDERS` set does not. The upstream `pluginQuota.test.ts` built-in-card contract must pass without weakening its assertions.
2. A Gemini CLI credential advertises `supports_quota` with a quota provider or declarative probe. Raw and normalized credentials must still resolve to the Gemini CLI card on both the quota and auth-file pages, never the generic plugin card.
3. A Gemini CLI credential without advertised plugin capability must retain its dedicated card; other built-in providers and genuine plugin-only providers must retain their existing routing.
4. Reapplying the durable customization must not duplicate the new set member or change the generated diff. The existing upstream modification manifest must still match.
5. The generated frontend must retain real Core HTTP route ownership, quota-cache persistence and restart hydration. Run the existing `pro-route-contract` E2E at final validation and retain its receipt and HTTP transcript, alongside the exact-input reproduction and full Management validation logs. This E2E does not assert external Gemini provider behavior or browser rendering.

Reproduce the original failure after applying the customization to the exact upstream tree and installing its locked dependencies: `bun test tests/pluginQuota.test.ts`. Final validation uses `scripts/validation/management.sh` on a separate clean tree and the E2E command documented in `scripts/validation/e2e/pro-route-contract/README.md`.
