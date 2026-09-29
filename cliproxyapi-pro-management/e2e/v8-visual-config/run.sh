#!/usr/bin/env bash
set -euo pipefail
# Use the existing task space. Optional HTTP target MUST be a disposable loopback Core.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$(python3 - "$@" <<'PY'
import json, sys
if len(sys.argv) < 4:
    raise SystemExit('usage: run.sh SPACE_ID HARNESS_URL ARTIFACT_DIR [CORE_URL MANAGEMENT_KEY]')
print(json.dumps(dict(space=int(sys.argv[1]), url=sys.argv[2], artifactDir=sys.argv[3],
                     coreUrl=sys.argv[4] if len(sys.argv)>4 else '',
                     managementKey=sys.argv[5] if len(sys.argv)>5 else '')))
PY
)"
{ printf 'const config = %s;\n' "$CONFIG"; cat "$SCRIPT_DIR/ego.mjs"; } | ego-browser nodejs
