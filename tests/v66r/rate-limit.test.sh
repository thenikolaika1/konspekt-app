#!/bin/bash
# v66: ограничение частоты библиотеки — только локальная копия PostgreSQL (НЕ production).
# Нужна база base65 (tests/v65/run.sh). export PGHOST=/path/to/socket PGPORT=54361
set -eo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X"
M="$ROOT/supabase/migrations"
$P -d postgres -c "drop database if exists rl66" -c "create database rl66 template base65" >/dev/null
$P -d rl66 -v ON_ERROR_STOP=1 -f "$M/20261107150000_v65_gift_ai_only.sql" >/dev/null
# миграция дважды подряд — повтор безопасен; тексты библиотеки и выдачи не меняются
SNAP="select md5(coalesce(string_agg(subject_id||book_id||paragraph_id||content::text, ';' order by 1), '')) from private.library_paragraphs"
before=$($P -d rl66 -tA -c "$SNAP")
FN="select md5(prosrc) || md5(coalesce(proacl::text, '')) || prosecdef || array_to_string(proconfig, ',') from pg_proc where oid = 'public.get_library_paragraph(text,text,text)'::regprocedure"
fn_before=$($P -d rl66 -tA -c "$FN")
$P -d rl66 -v ON_ERROR_STOP=1 -f "$ROOT/supabase/prepared/20261110120000_v34_4_library_rate_limit.sql" >/dev/null
$P -d rl66 -v ON_ERROR_STOP=1 -f "$ROOT/supabase/prepared/20261110120000_v34_4_library_rate_limit.sql" >/dev/null
after=$($P -d rl66 -tA -c "$SNAP")
[ "$before" = "$after" ] && echo "PASS M1. миграция (дважды): тексты библиотеки не изменились" || { echo "FAIL M1. тексты изменились"; exit 1; }
out=$($P -d rl66 -v ON_ERROR_STOP=1 -f "$HERE/rate-limit.test.sql")
echo "$out"
echo "$out" | grep -q "^FAIL" && exit 1 || true
# одновременные запросы одного ученика не проходят лимит вдвоём (advisory lock)
uid=$($P -d rl66 -tA -c "select id from auth.users where email = private.kn_email('KN-RBAAAA')")
$P -d rl66 -c "delete from private.library_reads where user_id = '$uid'" >/dev/null
$P -d rl66 -c "insert into private.library_reads (user_id, subject_id, book_id, paragraph_id) select '$uid', 'history', 'h8', 'y'||i from generate_series(1,19) i" >/dev/null
call() { $P -d rl66 -tA -c "select set_config('request.jwt.claims', '{\"sub\":\"$uid\",\"role\":\"authenticated\"}', false), set_config('request.method','POST',false); set role authenticated; select coalesce(public.get_library_paragraph('history','h8','$1') ->> 'error', 'ok');" | tail -1; }
for i in 41 42 43 44 45 46; do call p$i & done > "${TMPDIR:-/tmp}/rl66.out"; wait
ok=$(grep -c '^ok$' "${TMPDIR:-/tmp}/rl66.out" || true); lim=$(grep -c '^RATE_LIMITED$' "${TMPDIR:-/tmp}/rl66.out" || true)
[ "$ok" = "1" ] && [ "$lim" = "5" ] && echo "PASS C1. 6 одновременных новых параграфов при 19 из 20: выдан ровно 1, остальные RATE_LIMITED" || { echo "FAIL C1. ok=$ok limited=$lim"; exit 1; }
# откат: функция побайтно как до миграции, журнал удалён, тексты на месте; повторный откат и повторная миграция безопасны
PR="$ROOT/supabase/prepared"
before_rb=$($P -d rl66 -tA -c "$SNAP")
$P -d rl66 -v ON_ERROR_STOP=1 -f "$PR/20261110120000_v34_4_library_rate_limit.rollback.sql" >/dev/null
$P -d rl66 -v ON_ERROR_STOP=1 -f "$PR/20261110120000_v34_4_library_rate_limit.rollback.sql" >/dev/null
fn_after=$($P -d rl66 -tA -c "$FN"); gone=$($P -d rl66 -tA -c "select to_regclass('private.library_reads') is null")
[ "$fn_after" = "$fn_before" ] && [ "$gone" = "t" ] && [ "$($P -d rl66 -tA -c "$SNAP")" = "$before_rb" ] \
  && echo "PASS M2. откат (дважды): функция как до миграции (тело, права, security definer, search_path), журнал удалён, тексты не изменились" \
  || { echo "FAIL M2. откат: fn=$([ "$fn_after" = "$fn_before" ] && echo ok || echo diff) gone=$gone"; exit 1; }
$P -d rl66 -v ON_ERROR_STOP=1 -f "$PR/20261110120000_v34_4_library_rate_limit.sql" >/dev/null
lim=$($P -d rl66 -tA -c "select to_regclass('private.library_reads') is not null and position('RATE_LIMITED' in prosrc) > 0 from pg_proc where oid = 'public.get_library_paragraph(text,text,text)'::regprocedure")
[ "$lim" = "t" ] && echo "PASS M3. после отката миграция применяется снова" || { echo "FAIL M3"; exit 1; }
