#!/bin/bash
# Тесты v61 — только локально, на отдельной копии PostgreSQL 16 (НЕ production Supabase).
# Нужны: PostgreSQL 16 (initdb/pg_ctl), Node.js, Playwright с Chromium, распакованная v59 (для сравнения данных и PWA).
#   export PGHOST=/path/to/socket PGPORT=54361 PGLOG=/path/to/log.txt V59_DIR=/path/to/v59 PLAYWRIGHT_MODULE=/path/to/playwright
set -e
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X"
# база-образец: имитация Supabase + все миграции до v61
$P -d postgres -c "drop database if exists base61" -c "create database base61" >/dev/null
$P -d base61 -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do
  case "$f" in *paid_access.sql) continue ;; esac
  $P -d base61 -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || echo "миграция не применилась (ожидаемо только для ff_signup_hook без supabase_auth_admin): $(basename "$f")"
done
# 1. сценарии сервера
$P -d postgres -c "drop database if exists t61" -c "create database t61 template base61" >/dev/null
$P -d t61 -v ON_ERROR_STOP=1 -1 -f "$ROOT/supabase/migrations/20261024150000_paid_access.sql" >/dev/null
$P -d t61 -v ON_ERROR_STOP=1 -f "$HERE/access.test.sql"
# 2. одновременные запросы
bash "$HERE/concurrency.test.sh"
# 3. интерфейс (Chromium)
node "$HERE/v61.test.js"
