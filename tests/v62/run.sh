#!/bin/bash
# Тесты v62 — только локально, на отдельной копии PostgreSQL 16 (НЕ production Supabase). Настоящий GigaChat не вызывается.
# Нужна база-образец base61 из tests/v61/run.sh (имитация Supabase + миграции до v61).
#   export PGHOST=/path/to/socket PGPORT=54361 PLAYWRIGHT_MODULE=/path/to/playwright
set -e
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X"
M="$ROOT/supabase/migrations"
# база v62: base61 + платный доступ v61 + панель v61.3 + v62
$P -d postgres -c "drop database if exists base62" -c "create database base62 template base61" >/dev/null
$P -d base62 -v ON_ERROR_STOP=1 -f "$M/20261024150000_paid_access.sql" >/dev/null
$P -d base62 -v ON_ERROR_STOP=1 -f "$M/20261026120000_owner_panel.sql" >/dev/null
$P -d base62 -v ON_ERROR_STOP=1 -f "$M/20261028120000_v62_paid_library.sql" >/dev/null
# 1. библиотека, Premium, панель, бюджет
$P -d postgres -c "drop database if exists t62" -c "create database t62 template base62" >/dev/null
$P -d t62 -v ON_ERROR_STOP=1 -f "$HERE/v62.test.sql"
# 2. миграция: повторный запуск, данные на месте, откат и снова v62
bash "$HERE/migration.test.sh"
# 3. одновременные запросы: запуски и выдачи против резерва
bash "$HERE/concurrency.test.sh"
# 4. интерфейс и PWA (Chromium)
node "$HERE/v62.test.js"
