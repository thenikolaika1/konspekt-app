#!/bin/bash
# v61.3: панель владельца — параллельные запросы (отдельные процессы psql = отдельные подключения, как браузеры).
# Только локальная копия базы (НЕ production). Нужна база-образец base61 (run.sh) с миграциями v61 и панели.
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X -tA"
DB=oc61
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1 → '$2' ожидалось '$3'"; fi; }
OUT=$(mktemp -d)
$P -d postgres -c "drop database if exists $DB" -c "create database $DB template base61" >/dev/null
$P -d $DB -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/20261024150000_paid_access.sql" >/dev/null
$P -d $DB -v ON_ERROR_STOP=1 -f "$ROOT/supabase/migrations/20261026120000_owner_panel.sql" >/dev/null
# владелец и ученик (регистрация как register-invite), сессии входа
$P -d $DB -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create function public.t_reg(p_code text, p_kn text) returns uuid language plpgsql as $$
declare r jsonb; v uuid;
begin
  insert into private.beta_invites (code_hash, quota, expires_at) values (private.invite_code_hash(p_code), 1, now() + interval '7 days');
  r := public.register_invite_begin(p_code, p_kn, repeat('a', 64));
  insert into auth.users (email, raw_app_meta_data) values (private.kn_email(p_kn), jsonb_build_object('kn_reservation', r ->> 'reservation')) returning id into v;
  perform public.register_invite_finish(p_code, (r ->> 'reservation')::uuid, v);
  return v;
end $$;
select public.t_reg('CONCOWNER001', 'KN-WAAAAA'), public.t_reg('CONCSTUD0001', 'KN-SAAAAA');
select private.admin_set_owner('KN-WAAAAA');
update private.ai_limits set max_total_starts = 40, total_starts = 7 where id;
SQL
UO=$($P -d $DB -c "select id from auth.users where email = private.kn_email('KN-WAAAAA')")
SO=$($P -d $DB -c "insert into auth.sessions (user_id) values ('$UO') returning id")
CLAIMS="{\"sub\":\"$UO\",\"session_id\":\"$SO\",\"role\":\"authenticated\",\"is_anonymous\":false}"
# вызов как браузер владельца: роль authenticated, claims из JWT
api() { $P -d $DB -c "select set_config('request.jwt.claims', '$CLAIMS', false)" -c "set role authenticated" -c "$1" 2>&1 | tail -1; }
CODE=$($P -d $DB -c "select private.admin_panel_setup('KN-WAAAAA') ->> 'setup_code'")
PW='HJKMN-PQRST-23456-WXYZA'
TOK=$(api "select public.owner_panel_setup('$CODE', '$PW') ->> 'session'")
check "0. пароль установлен, сессия выдана" "$(echo "$TOK" | grep -cE '^[0-9a-f]{64}$')" "1"

# 1. 12 параллельных неверных паролей: ровно 5 засчитано, затем пауза — параллельность ограничение не обходит
for i in $(seq 1 12); do (api "select public.owner_unlock('AAAAA-BBBBB-CCCCC-DDDD$((i % 8 + 2))') ->> 'error'" > "$OUT/u$i") & done; wait
check "1. 12 параллельных неверных паролей: WRONG_PASSWORD ровно 4 раза" "$(cat "$OUT"/u* | grep -c WRONG_PASSWORD)" "4"
check "1. остальные 8 — LOCKED" "$(cat "$OUT"/u* | grep -c LOCKED)" "8"
check "1. засчитано ровно 5 неверных попыток, 1 пауза" "$($P -d $DB -c "select count(*) filter (where event='unlock_failed') || '/' || count(*) filter (where event='locked') from private.owner_security_log")" "5/1"
check "1. во время паузы и верный пароль — LOCKED" "$(api "select public.owner_unlock('$PW') ->> 'error'")" "LOCKED"
$P -d $DB -c "update private.owner_panel_secrets set locked_until = null, lock_level = 0, failed_count = 0" >/dev/null

# 2. выдача: два одинаковых запроса одновременно (двойное нажатие) → одна выдача
R1=$($P -d $DB -c "select gen_random_uuid()")
for i in 1 2; do (api "select public.owner_grant('$TOK', '$R1', 'KN-SAAAAA', 30, 20)::text" > "$OUT/g$i") & done; wait
check "2. двойное нажатие «Выдать»: одна выдача" "$($P -d $DB -c "select count(*) from private.access_grants g join auth.users u on u.id=g.user_id where u.email = private.kn_email('KN-SAAAAA') and g.kind='paid'")" "1"
check "2. оба ответа — успех (второй — повтор первого)" "$(cat "$OUT"/g* | grep -c '"result": "granted"')" "2"
check "2. один из них помечен replayed" "$(cat "$OUT"/g* | grep -c '"replayed": true')" "1"

# 3. две разные выдачи одному ученику одновременно → одна granted, вторая ALREADY_ACTIVE
$P -d $DB -c "update private.access_grants set revoked_at = now() where kind = 'paid'" >/dev/null
for i in 1 2; do (api "select coalesce(r ->> 'result', r ->> 'error') from (select public.owner_grant('$TOK', gen_random_uuid(), 'KN-SAAAAA', 30, 20) r) x" > "$OUT/d$i") & done; wait
check "3. две разные выдачи сразу: одна выдана" "$(cat "$OUT"/d* | grep -c granted)" "1"
check "3. вторая — ALREADY_ACTIVE" "$(cat "$OUT"/d* | grep -c ALREADY_ACTIVE)" "1"

# 4. продление: двойное нажатие и два разных продления по одному предпросмотру
EXP=$(api "select public.owner_preview('$TOK', 'KN-SAAAAA', 'extend', 30, 10) ->> 'starts_at'")
R2=$($P -d $DB -c "select gen_random_uuid()")
for i in 1 2; do (api "select public.owner_extend('$TOK', '$R2', 'KN-SAAAAA', 30, 10, null, '$EXP')::text" > "$OUT/e$i") & done; wait
check "4. двойное нажатие «Продлить»: продлено один раз" "$($P -d $DB -c "select count(*) from private.access_log where action='extend'")" "1"
EXP2=$(api "select public.owner_preview('$TOK', 'KN-SAAAAA', 'extend', 7, 5) ->> 'starts_at'")
for i in 1 2; do (api "select coalesce(r ->> 'result', r ->> 'error') from (select public.owner_extend('$TOK', gen_random_uuid(), 'KN-SAAAAA', 7, 5, null, '$EXP2') r) x" > "$OUT/f$i") & done; wait
check "4. два разных продления по одному предпросмотру: продлено один раз" "$(cat "$OUT"/f* | grep -c extended)" "1"
check "4. второе — STATE_CHANGED (срок уже изменился)" "$(cat "$OUT"/f* | grep -c STATE_CHANGED)" "1"
check "4. всего продлений в журнале — 2" "$($P -d $DB -c "select count(*) from private.access_log where action='extend'")" "2"

# 5. 14 параллельных созданий приглашения при пределе 10 в сутки → ровно 10 кодов
for i in $(seq 1 14); do (api "select coalesce(r ->> 'result', r ->> 'error') from (select public.owner_invite_create('$TOK', gen_random_uuid(), 'п$i', 7) r) x" > "$OUT/i$i") & done; wait
check "5. 14 параллельных созданий: создано ровно 10" "$($P -d $DB -c "select count(*) from private.invite_meta where source='panel'")" "10"
check "5. ответов DAILY_LIMIT — 4" "$(cat "$OUT"/i* | grep -c DAILY_LIMIT)" "4"
check "5. все коды уникальны" "$($P -d $DB -c "select count(distinct code_hash) from private.invite_meta where source='panel'")" "10"

# 6. 30 параллельных чтений панели — без ошибок и взаимных блокировок
deadlocks() { local n; n=$(grep -c "deadlock detected" "${PGLOG:-/dev/null}" 2>/dev/null); echo "${n:-0}"; }
before=$(deadlocks)
for i in $(seq 1 30); do (api "select (public.owner_overview('$TOK') ? 'students')::text" > "$OUT/r$i") & done; wait
check "6. 30 параллельных открытий главной: все ответили" "$(cat "$OUT"/r* | grep -c true)" "30"
after=$(deadlocks)
check "6. взаимных блокировок нет" "$((after - before))" "0"

rm -rf "$OUT"
echo "ИТОГО: $pass PASS, $fail FAIL"
