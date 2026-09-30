# Release HTTP gate failure scenarios (recorded before implementation)

1. Publishing bypasses a failed configuration, terminal usage, quota-provider process, or generated frontend route/restart test. Gate all through successful Management validation before uploading its publishable asset.
2. A Management-only release tests a rebuilt latest Core instead of the exact target release executable. Download the frozen target tag, verify archive checksums and available GitHub asset digest, and retain its identity receipt.
3. A Core release tests an ephemeral validation build instead of its actual Linux release archive. Extract the run's linux-amd64 release artifact for configuration, usage and frontend E2E. Keep the quota process fixture separately identified and hashed; it links the same patched source but is not the product executable.
4. The quota fixture is deleted with core.sh's build temporary directory. Build it only on explicit release-gate opt-in, retain it in validation artifacts, and record source/customization identity.
5. Latest frontend breaks current published Core. Pair once with candidate and once with the frozen current published executable; deduplicate identical executable hashes. Never build historical sources. With no published release, only candidate pairing runs.
6. GitHub permission, authentication or network failure is mistaken for no published Core. Preserve GitHub's designated latest-release lookup; only its explicit HTTP 404 permits first-release behavior. Other failures stop publication.
7. An archive has the wrong filename/tag, duplicate/missing checksum, mismatched checksum/API digest, duplicate executable, nonregular executable, or unsafe path. Reject before executing; retain failed download metadata/receipt.
8. A harness fails or times out after starting a process. Existing harnesses stop their processes and retain receipts/logs; the orchestrator retains overall input identities, command status and output, and workflow diagnostics upload runs with always().
9. A failed run exposes no useful artifact. Create orchestration receipt before work and update it even on failures; workflow uploads diagnostics independently of Management asset success.
10. Re-running the gate contaminates databases or silently overwrites evidence. Require a new evidence directory; each scenario uses isolated config/HOME/auth/SQLite and synthetic credentials.

The scope is actual HTTP, generated TypeScript transport, SQLite persistence and quota-provider dispatch. It does not assert browser rendering, external provider behavior or plugin ABI. Download checksum verification detects corruption/substitution relative to release metadata, not an independently signed publisher identity.
