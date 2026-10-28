#!/bin/bash
# v62: одновременные запросы (отдельные процессы psql = отдельные подключения) против резерва Premium.
# Только локальная копия базы (НЕ production). Нужна база-образец base62 (run.sh).
# Чтобы запросы действительно шли одновременно, «держатель» блокирует строку ai_limits, все участники встают в очередь
# и стартуют вместе после его коммита. Для проверки резерва в этой копии max_in_flight = 5 (иначе второй запуск
# остановил бы прежний предел «одна генерация одновременно», и резерв не проверялся бы); в production max_in_flight
# не меняется.
HERE=$(cd "$(dirname "$0")" && pwd)
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X -tA"
DB=cc62
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1 → '$2' ожидалось '$3'"; fi; }
OUT=$(mktemp -d)
$P -d postgres -c "drop database if exists $DB" -c "create database $DB template base62" >/dev/null
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
select public.t_reg('CCOWNER00001', 'KN-WAAAAA');
select private.admin_set_owner('KN-WAAAAA');
select public.t_reg('CCSTUD' || lpad(i::text, 6, '0'), 'KN-S' || substr('ABCDEFGHJKMNPQRSTUVWX', i, 1) || 'AAAA') from generate_series(1, 20) i;
select public.t_reg('CCTRIAL' || lpad(i::text, 5, '0'), 'KN-T' || substr('ABCDEFGHJKMNPQRSTUVWX', i, 1) || 'AAAA') from generate_series(1, 20) i;
select private.admin_grant('KN-SAAAAA', 'premium');
update private.ai_limits set beta_ends_at = now() - interval '1 day', max_in_flight = 5 where id;
create function public.t_uid(p_kn text) returns uuid language sql as $$ select id from auth.users where email = private.kn_email(p_kn) $$;
-- свободно ровно p_free (резерв Premium и владельца на месте)
create function public.t_free(p_free int) returns void language plpgsql as $$
declare b jsonb := private.budget_state();
begin
  update private.ai_limits set max_total_starts = total_starts + (b ->> 'premium_reserve')::int + (b ->> 'owner_reserve_left')::int + p_free where id;
end $$;
-- инвариант: после всех операций остаток не меньше резерва Premium
create function public.t_inv() returns text language sql as $$
  select case when (b ->> 'remaining')::int >= (b ->> 'premium_reserve')::int then 'ok' else 'BROKEN ' || b::text end
    from (select private.budget_state() b) x $$;
SQL
UO=$($P -d $DB -c "select public.t_uid('KN-WAAAAA')")
SO=$($P -d $DB -c "insert into auth.sessions (user_id) values ('$UO') returning id")
CLAIMS="{\"sub\":\"$UO\",\"session_id\":\"$SO\",\"role\":\"authenticated\",\"is_anonymous\":false}"
api() { $P -d $DB -c "select set_config('request.jwt.claims', '$CLAIMS', false)" -c "select set_config('request.method', 'POST', false)" -c "set role authenticated" -c "$1" 2>&1 | tail -1; }
svc() { $P -d $DB -c "set role service_role" -c "$1" 2>&1 | tail -1; }
CODE=$($P -d $DB -c "select private.admin_panel_setup('KN-WAAAAA') ->> 'setup_code'")
TOK=$(api "select public.owner_panel_setup('$CODE', 'HJKMN-PQRST-23456-WXYZA') ->> 'session'")
check "0. сессия панели" "$(echo "$TOK" | grep -cE '^[0-9a-f]{64}$')" "1"
# держатель: блокирует ai_limits на 1.5 с, пока участники встают в очередь
hold() { $P -d $DB -c "begin" -c "select 1 from private.ai_limits for update" -c "select pg_sleep(1.5)" -c "commit" >/dev/null & sleep 0.3; }
# запуск как analyze-pages (service_role): ID пользователя и note — заранее, как их знает функция
start_cmd() {
  local u n; u=$($P -d $DB -c "select public.t_uid('$1')")
  n=$($P -d $DB -c "select id from public.notes where user_id = '$u' and status = 'processing' order by created_at desc limit 1")
  echo "select coalesce(r ->> 'reason', r ->> 'result') from (select public.start_text_generation_v2('$u', '$n', 300, 600, 2) r) x"
}
L=ABCDEFGHJKMNPQRSTUVWX
mknote() { $P -d $DB -c "insert into public.notes (user_id, status, stage) values (public.t_uid('$1'), 'processing', 'uploading')" >/dev/null; }

# 1. пять пробных запусков сразу, места свободно ровно на 2 → 2 started, 3 premium_reserve, ни одного сверх
for k in A B C D E; do mknote "KN-T${k}AAAA"; done
$P -d $DB -c "select public.t_free(2)" >/dev/null
TOT0=$($P -d $DB -c "select total_starts from private.ai_limits")
for k in A B C D E; do start_cmd "KN-T${k}AAAA" > "$OUT/c$k"; done
hold; for k in A B C D E; do (svc "$(cat "$OUT/c$k")" > "$OUT/s$k") & done; wait
check "1. 5 пробных одновременно при свободных 2: started ровно 2" "$(cat "$OUT"/s? | grep -c started)" "2"
check "1. остальные 3 — premium_reserve" "$(cat "$OUT"/s? | grep -c premium_reserve)" "3"
check "1. счётчик запусков вырос ровно на 2" "$($P -d $DB -c "select total_starts - $TOT0 from private.ai_limits")" "2"
check "1. резерв Premium не тронут" "$($P -d $DB -c "select public.t_inv()")" "ok"
check "1. ошибок (deadlock и др.) нет" "$(cat "$OUT"/s? | grep -ci 'error\|deadlock')" "0"
$P -d $DB -c "update public.notes set status = 'ready', stage = 'done' where status = 'processing'" >/dev/null

# 2. выдача Premium и пробный запуск одновременно при свободных 15: проходит ровно одно (10 раундов)
ok=0; bad=0; errs=0
for r in $(seq 1 10); do
  KS="KN-S${L:$r:1}AAAA"; KT="KN-T${L:$((r + 5)):1}AAAA"
  mknote "$KT"; $P -d $DB -c "select public.t_free(15)" >/dev/null; SC=$(start_cmd "$KT")
  hold
  (api "select coalesce(r ->> 'result', r ->> 'error') from (select public.owner_grant('$TOK', gen_random_uuid(), '$KS', null, null) r) x" > "$OUT/g") &
  (svc "$SC" > "$OUT/t") &
  wait
  G=$(cat "$OUT/g"); T=$(cat "$OUT/t")
  n=0; [ "$G" = granted ] && n=$((n+1)); [ "$T" = started ] && n=$((n+1))
  [ $n = 1 ] && ok=$((ok+1)) || { bad=$((bad+1)); echo "  раунд $r: grant=$G start=$T"; }
  echo "$G$T" | grep -qi 'error\|deadlock' && errs=$((errs+1))
  [ "$($P -d $DB -c "select public.t_inv()")" = ok ] || { bad=$((bad+1)); echo "  раунд $r: инвариант нарушен"; }
  $P -d $DB -c "update public.notes set status = 'ready', stage = 'done' where status = 'processing'" >/dev/null
done
check "2. выдача + пробный одновременно: в каждом из 10 раундов прошло ровно одно, резерв цел" "$ok/$bad" "10/0"
check "2. ни одной ошибки и deadlock" "$errs" "0"

# 3. две выдачи разным ученикам одновременно, свободно 15 → одна granted, вторая BUDGET_LOW
$P -d $DB -c "select public.t_free(15)" >/dev/null
hold
(api "select coalesce(r ->> 'result', r ->> 'error') from (select public.owner_grant('$TOK', gen_random_uuid(), 'KN-SMAAAA', null, null) r) x" > "$OUT/a") &
(api "select coalesce(r ->> 'result', r ->> 'error') from (select public.owner_grant('$TOK', gen_random_uuid(), 'KN-SNAAAA', null, null) r) x" > "$OUT/b") &
wait
check "3. две выдачи при свободных 15: одна granted" "$(cat "$OUT"/a "$OUT"/b | grep -c granted)" "1"
check "3. вторая — BUDGET_LOW" "$(cat "$OUT"/a "$OUT"/b | grep -c BUDGET_LOW)" "1"
check "3. резерв цел" "$($P -d $DB -c "select public.t_inv()")" "ok"

# 4. снижение бюджета до минимума и выдача одновременно: после обоих резерв не нарушен
$P -d $DB -c "select public.t_free(15)" >/dev/null
B=$($P -d $DB -c "select max_total_starts from private.ai_limits"); MIN=$($P -d $DB -c "select private.budget_state() ->> 'min_budget'")
hold
(api "select coalesce(r ->> 'result', r ->> 'error') from (select public.owner_set_budget('$TOK', gen_random_uuid(), $MIN, $B) r) x" > "$OUT/sb") &
(api "select coalesce(r ->> 'result', r ->> 'error') from (select public.owner_grant('$TOK', gen_random_uuid(), 'KN-SPAAAA', null, null) r) x" > "$OUT/sg") &
wait
echo "  бюджет: $(cat "$OUT/sb"), выдача: $(cat "$OUT/sg")"
check "4. бюджет и выдача одновременно: резерв цел" "$($P -d $DB -c "select public.t_inv()")" "ok"
check "4. оба ответа — понятные коды, без ошибок" "$(cat "$OUT/sb" "$OUT/sg" | grep -cE '^(budget_set|BUDGET_TOO_LOW|granted|BUDGET_LOW)$')" "2"

# 5. Premium-ученик и пробный одновременно при «только резерв»: Premium проходит, пробный — нет
mknote "KN-SAAAAA"; mknote "KN-TVAAAA"; $P -d $DB -c "select public.t_free(0)" >/dev/null
C1=$(start_cmd KN-SAAAAA); C2=$(start_cmd KN-TVAAAA)
hold
(svc "$C1" > "$OUT/p") & (svc "$C2" > "$OUT/q") & wait
check "5. при свободных 0: Premium started, пробный premium_reserve" "$(cat "$OUT/p")/$(cat "$OUT/q")" "started/premium_reserve"
check "5. миграция v62 не меняет max_in_flight (в production остаётся 1)" \
  "$(grep -c 'max_in_flight *=' "$HERE/../../supabase/migrations/20261028120000_v62_paid_library.sql")" "0"
# 6. подарки: два разных подарка одному ученику одновременно → оба учтены одним сроком (7+5 дней, 2+3 генерации)
$P -d $DB -c "update private.ai_limits set max_total_starts = total_starts + 500 where id" >/dev/null
gift() { api "select coalesce(r ->> 'result', r ->> 'error') || coalesce('/' || (r ->> 'replayed'), '') from (select public.owner_gift('$TOK', '$1', '$2', $3, $4) r) x"; }
GQ="select coalesce(string_agg((ends_at - starts_at)::text || '/' || ai_quota, ',' order by starts_at), '-') from private.access_grants g join auth.users u on u.id = g.user_id where u.email = private.kn_email('KN-SRAAAA') and g.plan = 'gift' and g.revoked_at is null"
hold
(gift "$($P -d $DB -c "select gen_random_uuid()")" KN-SRAAAA 7 2 > "$OUT/ga") & (gift "$($P -d $DB -c "select gen_random_uuid()")" KN-SRAAAA 5 3 > "$OUT/gb") & wait
check "6. два подарка одному ученику одновременно: оба gifted" "$(cat "$OUT/ga" "$OUT/gb" | grep -c '^gifted')" "2"
check "6. итог — один подарочный срок 12 дней и 5 генераций (ничего не потеряно)" "$($P -d $DB -c "$GQ")" "12 days/5"
# двойное нажатие «Подтвердить подарок» (один request_id) → подарено один раз
RQ=$($P -d $DB -c "select gen_random_uuid()")
hold
(gift "$RQ" KN-SRAAAA 1 1 > "$OUT/gc") & (gift "$RQ" KN-SRAAAA 1 1 > "$OUT/gd") & wait
check "6. двойное нажатие: один подарок, второй ответ — повтор (replayed)" "$($P -d $DB -c "$GQ")/$(cat "$OUT/gc" "$OUT/gd" | grep -c 'gifted/true')" "13 days/6/1"
# два подарка разным ученикам при свободном бюджете на один (нужно ceil(10 × 1,5) = 15; свободно 15 сверх уже обещанных подарков)
$P -d $DB -c "select public.t_free(15 + ceil((private.budget_state() ->> 'gift_obligations')::int * 1.5)::int)" >/dev/null
hold
(gift "$($P -d $DB -c "select gen_random_uuid()")" KN-SSAAAA 30 10 > "$OUT/ge") & (gift "$($P -d $DB -c "select gen_random_uuid()")" KN-STAAAA 30 10 > "$OUT/gf") & wait
check "6. два подарка при бюджете на один: один gifted, второй BUDGET_LOW" "$(cat "$OUT/ge" "$OUT/gf" | grep -c '^gifted')/$(cat "$OUT/ge" "$OUT/gf" | grep -c BUDGET_LOW)" "1/1"
check "6. ошибок и deadlock нет" "$(cat "$OUT"/g[a-f] | grep -ci 'error\|deadlock')" "0"
rm -rf "$OUT"
echo "ИТОГО: $pass PASS, $fail FAIL"
[ $fail = 0 ]
