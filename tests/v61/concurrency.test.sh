#!/bin/bash
# Одновременные запросы к локальной копии базы (НЕ production): параллельные сессии psql.
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
PGLOG=${PGLOG:-/var/lib/postgresql/pg61/log.txt}
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X -At"
DB=c61
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 → получено [$2], ожидалось [$3]"; fail=$((fail+1)); fi; }

$P -d postgres -c "drop database if exists $DB" -c "create database $DB template base61" >/dev/null
$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/20261024150000_paid_access.sql >/dev/null
$P -d $DB >/dev/null <<'SQL'
update private.ai_limits set beta_starts_at = '2026-10-18 21:00+00', beta_ends_at = '2026-10-23 21:00+00', max_total_starts = 1000, total_starts = 7, max_in_flight = 3 where id;
create function public.t_user(p_kn text) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into auth.users (email, raw_app_meta_data) values (private.kn_email(p_kn), '{}') returning id into v;
  insert into private.user_entitlements (user_id, resource, plan, quota, source) values (v, 'text_generation', 'beta', 1, 'beta_invite');
  return v;
end $$;
create function public.t_note(p_uid uuid) returns uuid language sql as $$ insert into public.notes (user_id, status, stage) values (p_uid, 'processing', 'uploading') returning id $$;
SQL
U1=$($P -d $DB -c "select public.t_user('KN-AAAAAA')")
N1=$($P -d $DB -c "select public.t_note('$U1')"); N2=$($P -d $DB -c "select public.t_note('$U1')")

start() { # $1 user $2 note $3 sleep-after (держим транзакцию)
  $P -d $DB 2>&1 <<SQL | head -1
begin;
set local role service_role;
select public.start_text_generation_v2('$1','$2',300,600,2) ->> 'result';
\\o /dev/null
select pg_sleep(${3:-0});
commit;
SQL
}

# A. один пользователь, лимит 1, две разные note одновременно: вторая ждёт и получает limit_reached
start $U1 $N1 3 > ${TMPDIR:-/tmp}/cA1.out & sleep 0.7
t0=$(date +%s.%N); r2=$(start $U1 $N2 0); t1=$(date +%s.%N); wait
check "A. первая — started" "$(cat ${TMPDIR:-/tmp}/cA1.out)" "started"
check "A. вторая одновременно — limit_reached" "$r2" "limit_reached"
check "A. вторая ждала первую (блокировка, не гонка)" "$(echo "$t1 - $t0 > 1.5" | bc)" "1"
check "A. ровно один резерв" "$($P -d $DB -c "select count(*) from private.usage_ledger where user_id='$U1' and state='reserved'")" "1"

# B. одна и та же note дважды одновременно: второй запрос — already_processing, второго резерва нет
U2=$($P -d $DB -c "select public.t_user('KN-BBBBBB')"); N3=$($P -d $DB -c "select public.t_note('$U2')")
start $U2 $N3 3 > ${TMPDIR:-/tmp}/cB1.out & sleep 0.7
r2=$(start $U2 $N3 0); wait
check "B. первая — started" "$(cat ${TMPDIR:-/tmp}/cB1.out)" "started"
check "B. повтор той же note — already_processing" "$r2" "already_processing"
check "B. одна строка журнала, attempts=1" "$($P -d $DB -c "select count(*)||':'||max(attempts) from private.usage_ledger where op_key='$N3'")" "1:1"

# C. генерация и продление владельцем одновременно — без взаимной блокировки
U3=$($P -d $DB -c "select public.t_user('KN-CCCCCC')")
$P -d $DB -c "select private.admin_grant('KN-CCCCCC', null, 30, 2)" >/dev/null
N4=$($P -d $DB -c "select public.t_note('$U3')")
start $U3 $N4 2 > ${TMPDIR:-/tmp}/cC1.out & sleep 0.5
rx=$($P -d $DB -c "select private.admin_extend('KN-CCCCCC', null, 30, 2) ->> 'result'" 2>&1); wait
check "C. генерация — started" "$(cat ${TMPDIR:-/tmp}/cC1.out)" "started"
check "C. продление в это же время — extended" "$rx" "extended"

# D. разные пользователи при max_in_flight=1: второй — ai_busy
$P -d $DB -c "update private.ai_limits set max_in_flight = 1 where id; update private.usage_ledger set state='released', finalized_at=now() where state='reserved'" >/dev/null
U4=$($P -d $DB -c "select public.t_user('KN-DDDDDD')"); U5=$($P -d $DB -c "select public.t_user('KN-EEEEEE')")
N5=$($P -d $DB -c "select public.t_note('$U4')"); N6=$($P -d $DB -c "select public.t_note('$U5')")
start $U4 $N5 2 > ${TMPDIR:-/tmp}/cD1.out & sleep 0.5
r2=$(start $U5 $N6 0); wait
check "D. первый пользователь — started" "$(cat ${TMPDIR:-/tmp}/cD1.out)" "started"
check "D. второй одновременно — ai_busy" "$r2" "ai_busy"

# E. нагрузка: 40 параллельных операций (старт, итог, продление, статус) — ни одной взаимной блокировки
$P -d $DB -c "update private.ai_limits set max_in_flight = 50 where id; update private.usage_ledger set state='released', finalized_at=now() where state='reserved'" >/dev/null
for i in $(seq 1 8); do $P -d $DB -c "select public.t_user('KN-F$(printf '%05d' $i | tr '0123456789' 'ABCDEFGHJK')')" >/dev/null; done
before=$(grep -c "deadlock detected" "$PGLOG" </dev/null)
for i in $(seq 1 40); do
  (
    U=$($P -d $DB -c "select id from auth.users where email like 'id-kn-f%' order by random() limit 1")
    K=$($P -d $DB -c "select upper(split_part(substr(email,4),'@',1)) from auth.users where id='$U'")
    case $((i % 4)) in
      0) $P -d $DB -c "select private.admin_extend('$K', null, 1, 1)" >/dev/null 2>&1 || $P -d $DB -c "select private.admin_grant('$K', null, 1, 1)" >/dev/null 2>&1 ;;
      1) N=$($P -d $DB -c "select public.t_note('$U')"); start $U $N 0.2 >/dev/null; $P -d $DB -c "update public.notes set status='ready', stage='done' where id='$N'" >/dev/null ;;
      2) N=$($P -d $DB -c "select public.t_note('$U')"); start $U $N 0.1 >/dev/null; $P -d $DB -c "update public.notes set status='failed', stage='failed' where id='$N'" >/dev/null ;;
      3) $P -d $DB -c "select private.admin_status('$K') is not null" >/dev/null ;;
    esac
  ) &
done
wait
after=$(grep -c "deadlock detected" "$PGLOG" </dev/null)
check "E. 40 параллельных операций — взаимных блокировок нет" "$((after - before))" "0"
check "E. ни одной операции не списано больше лимита выдачи" "$($P -d $DB -c "select count(*) from private.access_grants g cross join lateral private.grant_usage(g.id) u where g.ai_quota is not null and u.used > g.ai_quota")" "0"
check "E. не больше одного consumed на note" "$($P -d $DB -c "select count(*) from (select op_key from private.usage_ledger where state='consumed' group by user_id, op_key having count(*) > 1) x")" "0"

# F. v61.1: параллельные запуски не обходят суточный предел неудач (идущие запуски считаются возможными неудачами)
$P -d $DB -c "update private.ai_limits set max_total_starts = 1000, max_in_flight = 10 where id; update private.usage_ledger set state='released', finalized_at=now() where state='reserved'; update private.generation_starts set outcome='failed', finished_at=now() where outcome is null" >/dev/null
U6=$($P -d $DB -c "select public.t_user('KN-ZZZZZC')"); $P -d $DB -c "select private.admin_grant('KN-ZZZZZC', null, 30, 10)" >/dev/null
N0=$($P -d $DB -c "select public.t_note('$U6')"); start $U6 $N0 0 >/dev/null; $P -d $DB -c "update public.notes set status='failed', stage='failed' where id='$N0'" >/dev/null
for i in 1 2 3; do N=$($P -d $DB -c "select public.t_note('$U6')"); (start $U6 $N 1.5 > ${TMPDIR:-/tmp}/cF$i.out) & sleep 0.2; done; wait
started=$(cat ${TMPDIR:-/tmp}/cF1.out ${TMPDIR:-/tmp}/cF2.out ${TMPDIR:-/tmp}/cF3.out | grep -c started)
check "F. при 1 неудаче из 3 параллельных запусков начат только 1 (предел 2 в сутки)" "$started" "1"
$P -d $DB -c "update public.notes set status='failed', stage='failed' where user_id='$U6' and status='processing'" >/dev/null
check "F. неудач за сутки не больше предела" "$($P -d $DB -c "select private.failed_starts('$U6', now()-interval '24 hours') <= 2")" "t"

echo "ИТОГО: $pass PASS, $fail FAIL"
[ $fail = 0 ]
