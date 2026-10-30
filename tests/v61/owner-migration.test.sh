#!/bin/bash
# v61.3: миграция панели — транзакция, частичные изменения, повтор, откат. Только локальная копия базы (НЕ production).
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X -tA"
V61="$ROOT/supabase/migrations/20261024150000_paid_access.sql"
M="$ROOT/supabase/migrations/20261026120000_owner_panel.sql"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1 → '$2' ожидалось '$3'"; fi; }
TMP=$(mktemp -d)
OBJ="select (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'
          and c.relname in ('owner_panel_secrets','owner_panel_sessions','owner_security_log','owner_requests','invite_meta'))
 + (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where (n.nspname='public' and p.proname like 'owner\_%') or (n.nspname='private' and (p.proname like 'panel\_%' or p.proname like 'admin_panel%' or p.proname='invite_meta_on_insert')))
 + (select count(*) from pg_trigger where tgname='beta_invites_meta')
 + (select count(*) from pg_attrdef d join pg_class c on c.oid=d.adrelid where c.relname='access_log' and pg_get_expr(d.adbin, d.adrelid) like '%konspekt.actor%')"
fresh() { $P -d postgres -c "drop database if exists $1" -c "create database $1 template base61" >/dev/null; $P -d $1 -v ON_ERROR_STOP=1 -f "$V61" >/dev/null; }
# данные v59/v61: участник с выдачей, код приглашения, журнал
seed() { $P -d $1 -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into private.beta_invites (code_hash, quota, label, expires_at) values (private.invite_code_hash('SEEDCODE0001'), 1, 'до панели', now() + interval '3 days');
do $$ declare r jsonb; v uuid; begin
  insert into private.beta_invites (code_hash, quota, expires_at) values (private.invite_code_hash('SEEDCODE0002'), 1, now() + interval '3 days');
  r := public.register_invite_begin('SEEDCODE0002', 'KN-SAAAAA', repeat('a', 64));
  insert into auth.users (email, raw_app_meta_data) values (private.kn_email('KN-SAAAAA'), jsonb_build_object('kn_reservation', r ->> 'reservation')) returning id into v;
  perform public.register_invite_finish('SEEDCODE0002', (r ->> 'reservation')::uuid, v);
  perform private.admin_grant('KN-SAAAAA', null, 30, 20, 'до панели');
end $$;
SQL
}
snap() { $P -d $1 -c "select md5(string_agg(x, '|' order by x)) from (
  select 'g' || g.id || g.kind || g.starts_at || g.ends_at || coalesce(g.ai_quota::text,'') || coalesce(g.revoked_at::text,'') x from private.access_grants g
  union all select 'i' || code_hash || coalesce(label,'') || coalesce(expires_at::text,'') || coalesce(redeemed_at::text,'') from private.beta_invites
  union all select 'l' || id || action || actor from private.access_log
  union all select 'u' || id || coalesce(email,'') from auth.users
  union all select 'a' || row_to_json(l)::text from private.ai_limits l) s"; }

fresh mp0; BASE=$($P -d mp0 -c "$OBJ")
check "M0. до миграции панели объектов панели нет" "$BASE" "0"

# 1. ошибка в середине файла (SQL Editor без ON_ERROR_STOP и psql с ON_ERROR_STOP) и перед COMMIT
L=$(grep -n "^create function public.owner_overview" "$M" | cut -d: -f1)
{ head -n $((L-1)) "$M"; echo "select 1/0;"; tail -n +$L "$M"; } > "$TMP/mid.sql"
C=$(grep -n "^commit;" "$M" | cut -d: -f1)
{ head -n $((C-1)) "$M"; echo "select 1/0;"; tail -n +$C "$M"; } > "$TMP/end.sql"
fresh mp1; seed mp1; S0=$(snap mp1)
$P -d mp1 -f "$TMP/mid.sql" >/dev/null 2>&1
check "M1. ошибка в середине (режим SQL Editor): объектов панели нет" "$($P -d mp1 -c "$OBJ")" "0"
check "M1. данные не изменились" "$(snap mp1)" "$S0"
fresh mp2; $P -d mp2 -v ON_ERROR_STOP=1 -f "$TMP/mid.sql" >/dev/null 2>&1
check "M2. ошибка в середине (psql ON_ERROR_STOP): объектов панели нет" "$($P -d mp2 -c "$OBJ")" "0"
fresh mp3; $P -d mp3 -f "$TMP/end.sql" >/dev/null 2>&1
check "M3. ошибка перед COMMIT: объектов панели нет" "$($P -d mp3 -c "$OBJ")" "0"
fresh mp4; $P -d postgres -c "drop database if exists mp5" -c "create database mp5 template base61" >/dev/null
$P -d mp5 -v ON_ERROR_STOP=1 -f "$M" >/dev/null 2>&1
check "M4. без миграции v61 — отказ, ничего не создано" "$($P -d mp5 -c "$OBJ")" "0"

# 2. нормальное применение поверх v61 с данными; повтор
seed mp4; S1=$(snap mp4)
$P -d mp4 -v ON_ERROR_STOP=1 -f "$M" >/dev/null 2>&1; check "M5. применение поверх v61.2 с данными — без ошибок" "$?" "0"
N=$($P -d mp4 -c "$OBJ")
check "M5. существующие выдачи, приглашения, журнал, аккаунты, лимиты ИИ не изменились" "$(snap mp4)" "$S1"
check "M5. у существующего кода появилась служебная строка (source=script)" "$($P -d mp4 -c "select count(*) from private.invite_meta where source='script'")" "2"
H1=$($P -d mp4 -c "select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')")
$P -d mp4 -f "$M" >/dev/null 2>&1
check "M6. повторный запуск отклонён целиком: функции те же" "$($P -d mp4 -c "select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')")" "$H1"
check "M6. повторный запуск: число объектов то же ($N)" "$($P -d mp4 -c "$OBJ")" "$N"
check "M7. функции v61.2 не изменены (start_text_generation_v2, admin_grant/extend/revoke, get_my_access_v2)" \
  "$($P -d mp0 -c "select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.proname)) from pg_proc p where p.proname in ('start_text_generation_v2','admin_grant','admin_extend','admin_revoke','get_my_access_v2','access_state','register_invite_begin','register_invite_finish')")" \
  "$($P -d mp4 -c "select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.proname)) from pg_proc p where p.proname in ('start_text_generation_v2','admin_grant','admin_extend','admin_revoke','get_my_access_v2','access_state','register_invite_begin','register_invite_finish')")"
check "M8. после миграции redeem_beta_invite недоступна ролям API, тело функции то же" "$($P -d mp4 -c "select has_function_privilege('authenticated', 'public.redeem_beta_invite(text)', 'execute')")" "f"
check "M8. журнал из SQL Editor по-прежнему пишет actor = postgres" "$($P -d mp4 -c "select (private.admin_extend('KN-SAAAAA', null, 7, 1) is not null)::text; select actor from private.access_log order by id desc limit 1" | tail -1)" "postgres"

# 3. откат (блок из файла миграции как есть)
sed -n '/^-- begin;$/,/^-- commit;$/s/^-- //p' "$M" > "$TMP/rb.sql"
S2=$(snap mp4)
$P -d mp4 -v ON_ERROR_STOP=1 -f "$TMP/rb.sql" >/dev/null 2>&1; check "M9. откат без ошибок" "$?" "0"
check "M9. после отката объектов панели нет" "$($P -d mp4 -c "$OBJ")" "0"
check "M9. выдачи, приглашения, журнал, аккаунты остались" "$(snap mp4)" "$S2"
check "M9. право на старую redeem_beta_invite возвращено откатом (как в v59)" "$($P -d mp4 -c "select has_function_privilege('authenticated', 'public.redeem_beta_invite(text)', 'execute')")" "t"
check "M9. регистрация по коду и v61 работают после отката" "$($P -d mp4 -c "select public.register_invite_begin('SEEDCODE0001', 'KN-SBAAAA', repeat('b', 64)) ->> 'result'")" "reserved"
for d in mp0 mp1 mp2 mp3 mp4 mp5; do $P -d postgres -c "drop database if exists $d" >/dev/null; done
rm -rf "$TMP"
echo "ИТОГО: $pass PASS, $fail FAIL"
