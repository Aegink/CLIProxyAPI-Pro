#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 4 || "$#" -gt 5 ]]; then
  echo "Usage: PRO_E2E_MANAGEMENT_KEY=... $0 SPACE_ID HARNESS_URL CORE_URL ARTIFACT_DIR [KEEP_OPEN]" >&2
  exit 2
fi
if [[ -z "${PRO_E2E_MANAGEMENT_KEY:-}" ]]; then
  echo "PRO_E2E_MANAGEMENT_KEY is required" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config="$(python3 - "$1" "$2" "$3" "$4" "${5:-false}" <<'PY'
import json
import os
import sys

print(json.dumps({
    'spaceId': int(sys.argv[1]),
    'url': sys.argv[2],
    'coreUrl': sys.argv[3],
    'artifactDir': sys.argv[4],
    'keepOpen': sys.argv[5].lower() == 'true',
    'managementKey': os.environ['PRO_E2E_MANAGEMENT_KEY'],
}))
PY
)"
{ printf 'const config = %s;\n' "${config}"; sed -n '1,$p' "${script_dir}/ego.mjs"; } | ego-browser nodejs
