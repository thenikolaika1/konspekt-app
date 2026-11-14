#!/bin/bash
# Тесты релиза v66 — локально; настоящий ИИ, Supabase и production не вызываются.
#   DENO=/path/to/deno  PGHOST=/path/to/socket PGPORT=54361 (база base65 из tests/v65/run.sh)  PLAYWRIGHT_MODULE=…
set -eo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT"
node tests/v66r/release-guard.test.mjs
${DENO:-deno} check supabase/functions/analyze-pages/index.ts
${DENO:-deno} run --allow-env --allow-read --allow-net=sim.local --import-map=tests/v66r/import_map.json tests/v66r/release-analyze.test.ts | grep -v "^\[analyze-pages"
${DENO:-deno} run --allow-env --allow-read --import-map=tests/v66r/import_map.json tests/v66r/server-key.test.ts
${DENO:-deno} run --allow-env --allow-read --allow-net=sim.local --import-map=tests/v66r/import_map.json tests/v66r/no-split.test.ts | grep -v "^\[analyze-pages"
# 1–4 фото: тот же след, что у production v33 (точная копия — коммит dab1677)
V33=$(mktemp -d); git -C "$ROOT" archive dab1677 supabase/functions/analyze-pages | tar -x -C "$V33"
trace() { FN_DIR="$1" ${DENO:-deno} run --allow-env --allow-read --allow-net=sim.local --import-map=tests/v66r/import_map.json tests/v66r/diff-v33.test.ts 2>/dev/null | grep "^TRACE"; }
A=$(trace "../../supabase/functions/analyze-pages"); B=$(trace "file://$V33/supabase/functions/analyze-pages")
[ -n "$A" ] && [ "$A" = "$B" ] && echo "PASS D1. 1–4 фото: 32 сценария analyze-pages v66 = production v33 (запросы к ИИ, промпты, конспект, списание)" || { echo "FAIL D1. след v66 отличается от v33"; exit 1; }
node tests/v66r/protect.test.js
node tests/v66r/camera-4.test.js
node tests/v66r/renewal.test.js
# v67: обновление PWA v66 → v67 под service worker: v66 — из git (dcc3c4b, production 14.11.2026), без сети сразу после обновления и после запуска с сетью
V66=$(mktemp -d); git -C "$ROOT" archive dcc3c4b | tar -x -C "$V66"
node tests/v66r/sw-update.test.js "$V66" "$ROOT" 66 67 immediate
node tests/v66r/sw-update.test.js "$V66" "$ROOT" 66 67 relaunch
node tests/v66r/sw-edge.test.js "$V66" "$ROOT"
bash tests/v66r/rate-limit.test.sh
bash tests/v66r/owner-tech-limit.test.sh
