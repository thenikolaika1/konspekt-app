#!/bin/bash
# Тесты эксперимента v66 «8 фотографий» — локально; настоящий ИИ и Supabase не вызываются.
#   DENO=/path/to/deno (Deno 2.x)
set -eo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT"
${DENO:-deno} check supabase/functions/analyze-pages/index.ts
${DENO:-deno} run --allow-env --allow-read --allow-net=sim.local --import-map=tests/v66/import_map.json tests/v66/analyze-sim.test.ts | grep -v "^\[analyze-pages\]"
${DENO:-deno} run --allow-read tests/v66/json-repair.test.ts
node tests/v66/camera-8.test.js
node --experimental-transform-types tests/v62/giga-upload.test.mjs | grep -v "^\[analyze-pages\]"
