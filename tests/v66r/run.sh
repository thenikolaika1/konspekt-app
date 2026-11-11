#!/bin/bash
# Тесты релиза v66 — локально; настоящий ИИ, Supabase и production не вызываются.
#   DENO=/path/to/deno  PGHOST=/path/to/socket PGPORT=54361 (база base65 из tests/v65/run.sh)  PLAYWRIGHT_MODULE=…
set -eo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT"
node tests/v66r/release-guard.test.mjs
${DENO:-deno} check supabase/functions/analyze-pages/index.ts
${DENO:-deno} run --allow-env --allow-read --allow-net=sim.local --import-map=tests/v66r/import_map.json tests/v66r/release-analyze.test.ts | grep -v "^\[analyze-pages"
node tests/v66r/protect.test.js
node tests/v66r/camera-4.test.js
# обновление PWA v65 → v66 под service worker: v65 — из git (47fccfc, production), без сети сразу после обновления и после запуска с сетью
V65=$(mktemp -d); git -C "$ROOT" archive 47fccfc | tar -x -C "$V65"
node tests/v66r/sw-update.test.js "$V65" "$ROOT" 65 66 immediate
node tests/v66r/sw-update.test.js "$V65" "$ROOT" 65 66 relaunch
node tests/v66r/sw-edge.test.js "$V65" "$ROOT"
bash tests/v66r/rate-limit.test.sh
