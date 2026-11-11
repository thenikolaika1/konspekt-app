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
bash tests/v66r/rate-limit.test.sh
