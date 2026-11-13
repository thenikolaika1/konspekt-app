#!/bin/bash
# v66.6 (применено к production 08.11.2026): владелец не попадает под суточный предел техошибок и автостоп ИИ.
# Только локальная копия PostgreSQL (НЕ production). Нужна base65 (tests/v65/run.sh). export PGHOST=… PGPORT=…
set -eo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X"
$P -d postgres -c "drop database if exists ot66" -c "create database ot66 template base65" >/dev/null
$P -d ot66 -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/20261107150000_v65_gift_ai_only.sql" >/dev/null
$P -d ot66 -v ON_ERROR_STOP=1 -f "$ROOT/supabase/applied/20261108165200_v66_6_owner_no_tech_daily_limit.sql" >/dev/null
$P -d ot66 -v ON_ERROR_STOP=1 -f "$ROOT/supabase/applied/20261108165200_v66_6_owner_no_tech_daily_limit.sql" >/dev/null # повтор безопасен
out=$($P -d ot66 -v ON_ERROR_STOP=1 -f "$HERE/owner-tech-limit.test.sql")
echo "$out"
echo "$out" | grep -q "^FAIL" && exit 1 || true
