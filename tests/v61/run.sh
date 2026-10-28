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
  case "$f" in *paid_access.sql|*owner_panel.sql|*v62_paid_library.sql) continue ;; esac
  $P -d base61 -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || echo "миграция не применилась (ожидаемо только для ff_signup_hook без supabase_auth_admin): $(basename "$f")"
done
# 1. сценарии сервера
$P -d postgres -c "drop database if exists t61" -c "create database t61 template base61" >/dev/null
$P -d t61 -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/20261024150000_paid_access.sql" >/dev/null
$P -d t61 -v ON_ERROR_STOP=1 -f "$HERE/access.test.sql"
# 1б. защита бюджета ИИ от повторов, отзыв во время пробного (v61.1)
$P -d postgres -c "drop database if exists bud61" -c "create database bud61 template base61" >/dev/null
$P -d bud61 -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/20261024150000_paid_access.sql" >/dev/null
$P -d bud61 -v ON_ERROR_STOP=1 -f "$HERE/budget.test.sql"
# 1в. переход v59 → v61 на копии «как в production», ученик из v59, откат (v61.1)
$P -d postgres -c "drop database if exists tr61" -c "create database tr61 template base61" >/dev/null
RB=$(mktemp); sed -n '/^-- begin;$/,/^-- commit;$/s/^-- //p' "$ROOT/supabase/migrations/20261024150000_paid_access.sql" > "$RB"
$P -d tr61 -v ON_ERROR_STOP=1 -v mig="$ROOT/supabase/migrations/20261024150000_paid_access.sql" -v rb="$RB" -f "$HERE/transition.test.sql"; rm -f "$RB"
# 2. одновременные запросы
bash "$HERE/concurrency.test.sh"
# 3. интерфейс (Chromium)
node "$HERE/v61.test.js"
# 4. панель владельца v61.3: сервер (пароль, сессия, права, подписки, приглашения, данные), миграция, параллельность, интерфейс
$P -d postgres -c "drop database if exists ow61" -c "create database ow61 template base61" >/dev/null
$P -d ow61 -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/20261024150000_paid_access.sql" >/dev/null
$P -d ow61 -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/20261026120000_owner_panel.sql" >/dev/null
$P -d ow61 -v ON_ERROR_STOP=1 -f "$HERE/owner.test.sql"
bash "$HERE/owner-migration.test.sh"
bash "$HERE/owner-concurrency.test.sh"
node "$HERE/owner-ui.test.js"
# 5. функции панели через настоящий PostgREST (если есть исполняемый файл: PGRST_BIN=/путь/postgrest), иначе SKIP
node "$HERE/owner-pgrst.test.js"
