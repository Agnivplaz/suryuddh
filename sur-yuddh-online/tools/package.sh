#!/usr/bin/env bash
# Package the project into a shareable zip.
#   bash tools/package.sh          -> ../sur-yuddh-online.zip
# Excludes node_modules, local databases, secrets and logs so the recipient can
# just run `cd server && npm install && npm start`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$(dirname "$ROOT")/sur-yuddh-online.zip}"

cd "$(dirname "$ROOT")"
rm -f "$OUT"
zip -r -q "$OUT" "$(basename "$ROOT")" \
  -x "*/node_modules/*" \
  -x "*/.git/*" \
  -x "*/.env" \
  -x "*/server/data/*.db" \
  -x "*/server/data/*.db-wal" \
  -x "*/server/data/*.db-shm" \
  -x "*.log" \
  -x "*/.DS_Store"

echo "packaged -> $OUT"
ls -lh "$OUT" | awk '{print "size:", $5}'
