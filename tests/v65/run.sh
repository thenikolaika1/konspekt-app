#!/bin/bash
# Тесты v65 (подарок «Только ИИ-генерации») — только локально, на отдельной копии PostgreSQL (НЕ production Supabase).
# Нужна база-образец base61 из tests/v61/run.sh.   export PGHOST=/path/to/socket PGPORT=54361
set -eo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X"
M="$ROOT/supabase/migrations"
# база как production до v65: base61 + v61 + панель v61.3 + v62 + каталог v64
$P -d postgres -c "drop database if exists base65" -c "create database base65 template base61" >/dev/null
for f in 20261024150000_paid_access.sql 20261026120000_owner_panel.sql 20261028120000_v62_paid_library.sql 20261107120000_v64_peryshkin_catalog.sql; do
  $P -d base65 -v ON_ERROR_STOP=1 -f "$M/$f" >/dev/null
done
# 1. миграция на базе с данными (сценарии v62 оставляют учеников, подарки, Premium): данные не меняются, повтор безопасен
$P -d postgres -c "drop database if exists m65" -c "create database m65 template base65" >/dev/null
$P -d m65 -v ON_ERROR_STOP=1 -f "$ROOT/tests/v62/v62.test.sql" >/dev/null
SNAP="select md5(string_agg(concat_ws('|', id, user_id, kind, plan, starts_at, ends_at, ai_quota, revoked_at, note), ';' order by id)) from private.access_grants"
SNAP2="select count(*) || '/' || md5(coalesce(string_agg(id::text, ',' order by id), '')) from private.access_log"
before=$($P -d m65 -tA -c "$SNAP")$($P -d m65 -tA -c "$SNAP2")
$P -d m65 -v ON_ERROR_STOP=1 -1 -f "$M/20261107150000_v65_gift_ai_only.sql" >/dev/null
$P -d m65 -v ON_ERROR_STOP=1 -1 -f "$M/20261107150000_v65_gift_ai_only.sql" >/dev/null
after=$($P -d m65 -tA -c "$SNAP")$($P -d m65 -tA -c "$SNAP2")
if [ "$before" = "$after" ]; then echo "PASS M1. миграция (дважды): выдачи, лимиты, сроки и журнал учеников не изменились"; else echo "FAIL M1. данные изменились: $before → $after"; exit 1; fi
# 2. сценарии подарка генераций (после сценариев v62 — те же помощники, владелец, ученики)
$P -d postgres -c "drop database if exists t65" -c "create database t65 template base65" >/dev/null
$P -d t65 -v ON_ERROR_STOP=1 -f "$M/20261107150000_v65_gift_ai_only.sql" >/dev/null
$P -d t65 -v ON_ERROR_STOP=1 -f "$ROOT/tests/v62/v62.test.sql" -f "$HERE/gift-ai.test.sql"
