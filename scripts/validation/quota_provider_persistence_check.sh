#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
  echo "Usage: $0 /path/to/clean/Cli-Proxy-API-Management-Center [artifact-dir]" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
upstream_root="$(cd "$1" && pwd)"
artifact_dir="${2:-/private/tmp/quota-provider-persistence-evidence}"
replay_root="$(mktemp -d /private/tmp/quota-provider-persistence-replay.XXXXXX)"

mkdir -p "${artifact_dir}"
cp -R "${upstream_root}/." "${replay_root}/"

apply_status=0
test_status=0
typecheck_status=0

bash "${repo_root}/cliproxyapi-pro-management/apply.sh" "${replay_root}" \
  >"${artifact_dir}/apply.log" 2>&1 || apply_status=$?

if [[ "${apply_status}" -eq 0 ]]; then
  (
    cd "${replay_root}"
    bun install --frozen-lockfile
  ) >"${artifact_dir}/install.log" 2>&1 || test_status=$?
fi

if [[ "${apply_status}" -eq 0 && "${test_status}" -eq 0 ]]; then
  (
    cd "${replay_root}"
    bun test tests/quotaPersistence.test.ts tests/quotaProviderSnapshot.test.ts
  ) >"${artifact_dir}/focused-tests.log" 2>&1 || test_status=$?

  (
    cd "${replay_root}"
    bun run type-check
  ) >"${artifact_dir}/type-check.log" 2>&1 || typecheck_status=$?
fi

passed=false
if [[ "${apply_status}" -eq 0 && "${test_status}" -eq 0 && "${typecheck_status}" -eq 0 ]]; then
  passed=true
fi

python3 -c 'import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
path.write_text(json.dumps({
    "passed": sys.argv[2] == "true",
    "applyStatus": int(sys.argv[3]),
    "testStatus": int(sys.argv[4]),
    "typecheckStatus": int(sys.argv[5]),
    "replayRoot": sys.argv[6],
}, indent=2) + "\n")' \
  "${artifact_dir}/result.json" "${passed}" "${apply_status}" "${test_status}" \
  "${typecheck_status}" "${replay_root}"

echo "quota provider persistence artifact: ${artifact_dir}"
echo "independent replay: ${replay_root}"
[[ "${passed}" == true ]]
