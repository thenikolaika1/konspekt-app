#!/bin/bash
# Тесты v62 — только локально, на отдельной копии PostgreSQL 16 (НЕ production Supabase). Настоящий GigaChat не вызывается.
# Нужна база-образец base61 из tests/v61/run.sh (имитация Supabase + миграции до v61).
#   export PGHOST=/path/to/socket PGPORT=54361 PLAYWRIGHT_MODULE=/path/to/playwright
set -eo pipefail
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
# 1б. права: копия, где права по умолчанию в public как в production Supabase (TRUNCATE/REFERENCES/TRIGGER ролям API)
$P -d postgres -c "drop database if exists sec62" -c "create database sec62" >/dev/null
$P -d sec62 -v ON_ERROR_STOP=1 -f "$ROOT/tests/v61/bootstrap.sql" >/dev/null 2>&1
# в production у bookmarks/bookmark_notes RLS включён (проверено чтением каталога), в имитации — нет: как в production
$P -d sec62 -v ON_ERROR_STOP=1 -c "alter table public.bookmarks enable row level security" -c "alter table public.bookmark_notes enable row level security" \
  -c "grant truncate, references, trigger on all tables in schema public to anon, authenticated, service_role" \
  -c "alter default privileges for role postgres in schema public grant truncate, references, trigger on tables to anon, authenticated, service_role" >/dev/null
for f in "$M"/*.sql; do
  case "$f" in *paid_access.sql|*owner_panel.sql|*v62_paid_library.sql) continue ;; esac
  $P -d sec62 -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || true
done
for f in 20261024150000_paid_access.sql 20261026120000_owner_panel.sql 20261028120000_v62_paid_library.sql; do
  $P -d sec62 -v ON_ERROR_STOP=1 -f "$M/$f" >/dev/null
done
$P -d sec62 -v ON_ERROR_STOP=1 -f "$HERE/security.test.sql"
# 2. миграция: повторный запуск, данные на месте, откат и снова v62
bash "$HERE/migration.test.sh"
# 2б. весь выпуск на копии как production: права и триггеры Supabase, данные той же формы, копия → миграция → тексты → откат
bash "$HERE/prodcopy.test.sh"
# 3. одновременные запросы: запуски и выдачи против резерва
bash "$HERE/concurrency.test.sh"
# 3в. интерфейс v61.3 (у учеников до обновления PWA) с базой v62: все его вызовы работают
bash "$HERE/oldclient.test.sh"
# 3б. перенос 77 параграфов: манифест = публичный каталог, закрытых текстов в публичных файлах нет
node "$HERE/library-manifest.test.mjs"
# 4. интерфейс и PWA (Chromium)
node "$HERE/v62.test.js"
# 5. загрузка страниц в GigaChat (providers.ts) с имитацией GigaChat API — настоящий GigaChat не вызывается
node --experimental-transform-types "$HERE/giga-upload.test.mjs" | grep -v "^\[analyze-pages\]"
