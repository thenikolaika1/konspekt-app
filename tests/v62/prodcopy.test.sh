#!/bin/bash
# v62 на копии «как production» (НЕ production): права по умолчанию и RLS как в Supabase, событийный триггер ensure_rls,
# данные той же формы, что в production на 28.10 (46 пользователей, 1 пробная выдача и 1 владельца, 10 старых прав,
# 9 конспектов, журнал генераций, аналитика; бюджет 40/10). Все данные и тексты — вымышленные.
# Порядок как при выпуске: резервная копия → миграция → тексты (с контрольными суммами) → проверки → восстановление.
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X -tA"
PGD="-h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres"
M="$ROOT/supabase/migrations"; DB=pc62
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1 → '$2' ожидалось '$3'"; fi; }
OUT=$(mktemp -d); trap 'rm -rf "$OUT"' EXIT

# ---------- копия схемы production (v61.3) ----------
$P -d postgres -c "drop database if exists $DB" -c "drop database if exists ${DB}r" -c "create database $DB" >/dev/null
$P -d $DB -v ON_ERROR_STOP=1 -f "$ROOT/tests/v61/bootstrap.sql" >/dev/null 2>&1
$P -d $DB -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
-- как в production: RLS на закладках, права по умолчанию в public, событийный триггер Supabase ensure_rls
alter table public.bookmarks enable row level security;
alter table public.bookmark_notes enable row level security;
grant truncate, references, trigger on all tables in schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant truncate, references, trigger on tables to anon, authenticated, service_role;
create function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path to 'pg_catalog' as $$
declare cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands()
              where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') and object_type in ('table', 'partitioned table') loop
    if cmd.schema_name is not null and cmd.schema_name in ('public') then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
      exception when others then null;
      end;
    end if;
  end loop;
end $$;
create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function public.rls_auto_enable();
SQL
for f in "$M"/*.sql; do
  case "$f" in *paid_access.sql|*owner_panel.sql|*v62_paid_library.sql) continue ;; esac
  $P -d $DB -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || true
done
$P -d $DB -v ON_ERROR_STOP=1 -f "$M/20261024150000_paid_access.sql" >/dev/null
$P -d $DB -v ON_ERROR_STOP=1 -f "$M/20261026120000_owner_panel.sql" >/dev/null

# ---------- данные той же формы, что в production ----------
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
do $$ declare v uuid; i int; begin
  -- 6 бывших участников F&F (окно закрыто) и 2 старых служебных аккаунта с ручным доступом — без выдач
  update private.access_settings set trial_on_register = false;
  for i in 1..6 loop
    insert into auth.users (email) values (private.kn_email('KN-F' || substr('ABCDEFGH', i, 1) || 'AAAA')) returning id into v;
    insert into private.user_entitlements (user_id, resource, plan, quota, source) values (v, 'text_generation', 'beta', 1, 'beta_invite');
  end loop;
  for i in 1..2 loop
    insert into auth.users (email) values (private.kn_email('KN-M' || substr('AB', i, 1) || 'AAAA')) returning id into v;
    insert into private.user_entitlements (user_id, resource, plan, quota, source) values (v, 'text_generation', 'beta', 1000, 'manual');
  end loop;
  update private.access_settings set trial_on_register = true;
  -- гости (анонимные входы)
  for i in 1..36 loop insert into auth.users (is_anonymous) values (true); end loop;
end $$;
select public.t_reg('PCOWNER00001', 'KN-WAAAAA'), public.t_reg('PCTRIAL00001', 'KN-TAAAAA');
select private.admin_set_owner('KN-WAAAAA');
-- владелец зарегистрировался до пробных периодов: у него только роль владельца (как в production)
delete from private.access_grants where kind = 'trial' and user_id = (select id from auth.users where email = private.kn_email('KN-WAAAAA'));
update private.ai_limits set beta_starts_at = '2026-10-18 21:00+00', beta_ends_at = '2026-10-23 21:00+00',
  max_total_starts = 40, total_starts = 10, max_in_flight = 1, max_user_starts = 3 where id;
-- 9 конспектов (готовые и неудачные) у разных пользователей, журнал генераций
insert into public.notes (user_id, status, stage, title, content)
  select u.id, case when g % 3 = 0 then 'failed' else 'ready' end, case when g % 3 = 0 then 'failed' else 'done' end, 'Конспект ' || g,
         case when g % 3 = 0 then null else jsonb_build_object('meta', jsonb_build_object('title', 'Тест ' || g)) end
    from generate_series(1, 9) g join lateral (select id from auth.users where not is_anonymous order by email offset (g % 4) limit 1) u on true;
insert into private.generation_starts (user_id, op_key, started_at, outcome, finished_at)
  select n.user_id, n.id::text, now() - interval '3 days', case when n.status = 'ready' then 'ok' else 'failed' end, now() - interval '3 days'
    from public.notes n limit 3;
insert into analytics.app_events (id, user_id, kind, created_at)
  select gen_random_uuid(), (select id from auth.users where not is_anonymous order by email limit 1), 'app_cold', now() - (g || ' minutes')::interval from generate_series(1, 116) g;
drop function public.t_reg(text, text);
SQL
[ $? = 0 ] || echo "FAIL подготовка данных"
COUNTS="select (select count(*) from auth.users) || '/' || (select count(*) from private.access_grants) || '/' || (select count(*) from private.user_entitlements) || '/' || (select count(*) from public.notes) || '/' || (select count(*) from private.generation_starts) || '/' || (select count(*) from analytics.app_events) || '/' || (select max_total_starts || ':' || total_starts || ':' || max_in_flight from private.ai_limits)"
check "0. копия как production: 46 пользователей, 2 выдачи, 10 старых прав, 9 конспектов, 3 запуска, 116 событий, бюджет 40:10:1" \
  "$($P -d $DB -c "$COUNTS")" "46/2/10/9/3/116/40:10:1"
# отпечаток данных: каждая таблица целиком (кроме изменяемых миграцией plans/access_settings — их отдельно)
DATA="select string_agg(t || '=' || h, ' ' order by t) from (
  select 'auth.users' t, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from auth.users x union all
  select 'notes', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.notes x union all
  select 'grants', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.access_grants x union all
  select 'entitlements', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.user_entitlements x union all
  select 'ledger', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.usage_ledger x union all
  select 'starts', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.generation_starts x union all
  select 'access_log', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.access_log x union all
  select 'invites', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.beta_invites x union all
  select 'events', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from analytics.app_events x union all
  select 'ai_limits', md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.ai_limits x union all
  select 'settings_old_columns', md5((select (to_jsonb(s) - 'budget_reserve_factor' - 'owner_reserve_starts' - 'budget_warn_percent')::text from private.access_settings s)) union all
  select 'owner_panel', md5(coalesce((select string_agg(x::text, '|' order by x::text) from private.owner_panel_secrets x), ''))) z"
STATE="select string_agg(coalesce(u.email, 'guest') || '=' || (private.access_state(u.id) ->> 'status') || '/' || coalesce(private.access_state(u.id) ->> 'kind', '-') || '/' || coalesce(private.access_state(u.id) ->> 'ai_quota', '-'), ',' order by u.email, u.id) from auth.users u"
FUNCL="select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(p.prosrc) || ' ' || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '') || ' ' || coalesce(array_to_string(p.proacl, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private', 'analytics') order by 1"
FUNCS="select md5(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || md5(p.prosrc) || p.prosecdef || coalesce(array_to_string(p.proconfig, ','), '') || coalesce(array_to_string(p.proacl, ','), ''), '|' order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private', 'analytics')"
SNAP="$ROOT/supabase/release/v62-snapshot.sql"
$P -d $DB -f "$SNAP" > "$OUT/snap-before.txt"
# структура: таблицы (RLS, действующие права на таблицы — пустой ACL = права по умолчанию владельца), политики, права на колонки
RELS="select md5(string_agg(x, '|' order by x)) from (
  select n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || c.relrowsecurity || ':' || array_to_string(coalesce(c.relacl, acldefault('r', c.relowner)), ',') x
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private', 'analytics') and c.relkind in ('r', 'v', 'm', 'p') union all
  select 'policy ' || schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '')
    from pg_policies where schemaname in ('public', 'private', 'analytics', 'storage') union all
  select 'col ' || table_schema || '.' || table_name || '.' || column_name || ':' || grantee || ':' || privilege_type
    from information_schema.column_privileges where table_schema in ('public', 'private', 'analytics') and grantee in ('anon', 'authenticated', 'service_role')) z"
R0=$($P -d $DB -c "$RELS"); RELL=$(echo "$RELS" | sed -e 's/^select md5(string_agg(x, .|. order by x)) from (/select x from (/' -e 's/) z$/) z order by x/'); $P -d $DB -c "$RELL" > "$OUT/r0.txt"
D0=$($P -d $DB -c "$DATA"); S0=$($P -d $DB -c "$STATE"); F0=$($P -d $DB -c "$FUNCS"); $P -d $DB -c "$FUNCL" > "$OUT/f0.txt"

# ---------- 1. резервная копия до миграции (как backup-before-v62.ps1: полная и только данные) ----------
pg_dump $PGD -d $DB -Fc -f "$OUT/full.dump" && pg_dump $PGD -d $DB -Fc --data-only -t 'public.*' -t 'private.*' -t 'analytics.*' -t auth.users -f "$OUT/data.dump"
check "1. резервные копии сделаны и читаются" "$(pg_restore -l "$OUT/full.dump" >/dev/null && pg_restore -l "$OUT/data.dump" >/dev/null && echo ok)" "ok"
# та же проверка структуры, что в backup-before-v62.ps1 (те же выражения): функции, политики, RLS в копии = в базе
LIVE=$($P -d $DB -c "select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private','analytics') and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')) || '|' || (select count(*) from pg_policies where schemaname in ('public','private','analytics')) || '|' || (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relrowsecurity and c.relkind in ('r','p') and n.nspname in ('public','private','analytics'))")
pg_restore -l "$OUT/full.dump" > "$OUT/toc.txt"
TOCS="$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ FUNCTION (public|private|analytics) ' "$OUT/toc.txt")|$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ POLICY (public|private|analytics) ' "$OUT/toc.txt")|$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ ROW SECURITY (public|private|analytics) ' "$OUT/toc.txt")"
check "1. копия: функций, политик RLS, таблиц с RLS — столько же, сколько в базе ($LIVE)" "$TOCS" "$LIVE"
MISS=0; for need in 'TABLE DATA private access_grants' 'TABLE DATA private ai_limits' 'TABLE DATA private access_settings' 'TABLE DATA public notes' \
  'TABLE DATA auth users' 'ACL public FUNCTION get_my_access_v2()' 'ACL public TABLE notes' 'POLICY public notes notes: select own'; do
  grep -qF -- " $need " "$OUT/toc.txt" || { MISS=$((MISS+1)); echo "  нет в копии: $need"; }
done
check "1. в копии есть данные выдач, бюджета, настроек, конспектов, пользователей; права и политики" "$MISS" "0"

# ---------- 1б. пробный прогон (v62-dryrun.sql): все шаги и самопроверки, затем rollback ----------
DRY="$ROOT/supabase/release/v62-dryrun.sql"
(cd "$ROOT" && node tools/make-dryrun.mjs supabase/migrations/20261028120000_v62_paid_library.sql "$OUT/dry.sql" 2>/dev/null)
check "1б. v62-dryrun.sql пересобирается из миграции байт в байт (файлы не разошлись)" "$(cmp -s "$OUT/dry.sql" "$DRY" && echo same)" "same"
OUTD=$($P -d $DB -v ON_ERROR_STOP=1 -f "$DRY" 2>&1); RC=$?
check "1б. пробный прогон: все шаги и самопроверки прошли, в конце ROLLBACK" "$RC/$(echo "$OUTD" | grep -c 'ПРОБНЫЙ ПРОГОН пройден')" "0/1"
check "1б. после пробного прогона база как была: данные, функции, таблицы и права, нет таблицы текстов" \
  "$($P -d $DB -c "$DATA")|$($P -d $DB -c "$FUNCS")|$($P -d $DB -c "$RELS")|$($P -d $DB -c "select to_regclass('private.library_paragraphs') is null")" "$D0|$F0|$R0|t"

# занятая база: другой запрос держит access_settings (как идущая генерация) — пробный прогон не ждёт дольше 5 с и откатывается
$P -d $DB -c "begin" -c "select count(*) from private.access_settings" -c "select pg_sleep(12)" -c "commit" >/dev/null 2>&1 &
HOLD=$!; sleep 1
T0=$(date +%s); OUTL=$($P -d $DB -v ON_ERROR_STOP=1 -f "$DRY" 2>&1); RCL=$?; T1=$(date +%s); wait $HOLD
check "1б. база занята другим запросом: пробный прогон остановился по lock_timeout за ≤ 7 с, не дожидаясь" \
  "$RCL/$(echo "$OUTL" | grep -c 'lock timeout')/$([ $((T1 - T0)) -le 7 ] && echo fast)" "3/1/fast"
check "1б. после остановки по lock_timeout база как была" "$($P -d $DB -c "$DATA")|$($P -d $DB -c "$FUNCS")" "$D0|$F0"

# ---------- 2. миграция ----------
OUTM=$($P -d $DB -v ON_ERROR_STOP=1 -f "$M/20261028120000_v62_paid_library.sql" 2>&1); RC=$?
check "2. миграция v62 применилась на копии production" "$RC" "0"; [ $RC = 0 ] || echo "$OUTM" | head -5
check "2. данные учеников, конспекты, выдачи, права, журналы, аналитика, бюджет — без изменений" "$($P -d $DB -c "$DATA")" "$D0"
check "2. статус доступа каждого пользователя тот же (служебные аккаунты и F&F не тронуты)" "$($P -d $DB -c "$STATE")" "$S0"
check "2. событийный триггер ensure_rls не помешал; таблица текстов с RLS и без прав ролей API" \
  "$($P -d $DB -c "select relrowsecurity::text || has_table_privilege('authenticated', oid, 'select') || has_table_privilege('service_role', oid, 'select') from pg_class where oid = 'private.library_paragraphs'::regclass")" "truefalsefalse"
check "2. TRUNCATE/TRIGGER у ролей API на public сняты (были, как в production)" \
  "$($P -d $DB -c "select count(*) from pg_class c, unnest(array['anon','authenticated','service_role']) r where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and (has_table_privilege(r, c.oid, 'truncate') or has_table_privilege(r, c.oid, 'trigger'))")" "0"
check "2. повторный запуск отклонён, ничего не изменилось" "$($P -d $DB -v ON_ERROR_STOP=1 -f "$M/20261028120000_v62_paid_library.sql" >/dev/null 2>&1; echo $?)/$($P -d $DB -c "$DATA" | md5sum | cut -c1-8)" "3/$(echo "$D0" | md5sum | cut -c1-8)"

# ---------- 3. тексты: генератор → манифест на отдельной копии → SQL со встроенными контрольными суммами ----------
cat > "$OUT/catalog.js" <<'JS'
window.K.library.setCatalog({ grades: [{ id: "8", title: "8 класс" }], profiles: [], subjects: [
  { id: "history", title: "История", books: [{ id: "h8", title: "История 8", grade: "8", paragraphs: [
    { id: "h8-p1", number: "§ 1", title: "Тест 1", content: { schemaVersion: 1, meta: { title: "ТЕСТ-1" }, sections: [{ id: "s", heading: "x", blocks: [{ id: "b", type: "PARAGRAPH", text: "СЕКРЕТ-1 «кавычки» 'апостроф' $$ \\ \n перенос" }] }] } },
    { id: "h8-p2", number: "§ 2", title: "Тест 2", content: { schemaVersion: 1, meta: { title: "ТЕСТ-2", n: 1.50, z: null } } }] }] },
  { id: "physics", title: "Физика", books: [{ id: "f8", title: "Физика 8", grade: "8", paragraphs: [
    { id: "f8-p1", number: "§ 1", title: "Тест 3", content: { schemaVersion: 1, meta: { title: "ТЕСТ-3", formula: "E = mc²" } } }] }] },
  { id: "biology", title: "Биология", books: [{ id: "b8", title: "Био 8", grade: "8", paragraphs: [
    { id: "b8-p1", number: "§ 1", title: "Не переносится", content: { meta: { title: "БИО" } } }] }] }] });
JS
(cd "$ROOT" && node tools/library-split.mjs "$OUT/catalog.js" --index "$OUT/index.js" --seed "$OUT/seed0.sql" 2>/dev/null)
$P -d postgres -c "drop database if exists ${DB}m" -c "create database ${DB}m template $DB" >/dev/null
$P -d ${DB}m -v ON_ERROR_STOP=1 -f "$OUT/seed0.sql" >/dev/null 2>&1
$P -d ${DB}m -c "select subject_id || chr(9) || book_id || chr(9) || paragraph_id || chr(9) || encode(sha256(convert_to(content::text, 'UTF8')), 'hex') from private.library_paragraphs order by 1" > "$OUT/manifest.tsv"
$P -d postgres -c "drop database ${DB}m" >/dev/null
(cd "$ROOT" && node tools/library-split.mjs "$OUT/catalog.js" --index "$OUT/index.js" --seed "$OUT/seed.sql" --expect "$OUT/manifest.tsv" 2>/dev/null)
check "3. манифест: 3 параграфа (история и физика), биология не переносится" "$(wc -l < "$OUT/manifest.tsv" | tr -d ' ')/$(grep -c biology "$OUT/manifest.tsv")" "3/0"
check "3. публичный каталог без текстов" "$(grep -c 'СЕКРЕТ\|ТЕСТ-' "$OUT/index.js")" "0"
OUTS=$($P -d $DB -v ON_ERROR_STOP=1 -f "$OUT/seed.sql" 2>&1); RC=$?
check "3. тексты загружены, контрольные суммы каждого параграфа совпали" "$RC/$(echo "$OUTS" | grep -c 'контрольные суммы совпали: 3')" "0/1"
check "3. повторная загрузка — без дублей, суммы снова совпали" "$($P -d $DB -v ON_ERROR_STOP=1 -f "$OUT/seed.sql" 2>&1 | grep -c 'совпали: 3')/$($P -d $DB -c "select count(*) from private.library_paragraphs")" "1/3"
sed "s/'h8-p2', '[0-9a-f]\{64\}'/'h8-p2', '$(printf '0%.0s' $(seq 64))'/" "$OUT/seed.sql" > "$OUT/bad.sql"
$P -d postgres -c "drop database if exists ${DB}b" -c "create database ${DB}b template $DB" >/dev/null
$P -d ${DB}b -c "truncate private.library_paragraphs" >/dev/null
check "3. неверная контрольная сумма → ошибка, загрузка откатилась целиком (0 строк)" \
  "$($P -d ${DB}b -v ON_ERROR_STOP=1 -f "$OUT/bad.sql" 2>&1 | grep -c 'контрольная сумма не совпала: history/h8/h8-p2')/$($P -d ${DB}b -c "select count(*) from private.library_paragraphs")" "1/0"
$P -d postgres -c "drop database ${DB}b" >/dev/null
check "2+3. после миграции и текстов данные учеников по-прежнему без изменений" "$($P -d $DB -c "$DATA")" "$D0"
$P -d $DB -f "$SNAP" > "$OUT/snap-after.txt"
check "2+3. снимок v62-snapshot.sql (как в инструкции, 19 таблиц) до и после — одинаковый" \
  "$(wc -l < "$OUT/snap-before.txt" | tr -d ' ')/$(cmp -s "$OUT/snap-before.txt" "$OUT/snap-after.txt" && echo same)" "19/same"

# ---------- 4. доступ к библиотеке по ролям (как запрос из браузера: роль authenticated, sub из JWT, POST) ----------
uid() { $P -d $DB -c "select id from auth.users where email = private.kn_email('$1')"; }
lib() {  # $1 — uid или пусто (гость без входа)
  local claims; if [ -n "$1" ]; then claims="{\"sub\":\"$1\",\"role\":\"authenticated\"}"; else claims='{"role":"anon"}'; fi
  $P -d $DB -c "select set_config('request.jwt.claims', '$claims', false)" -c "select set_config('request.method', 'POST', false)" \
    -c "set role $([ -n "$1" ] && echo authenticated || echo anon)" -c "select coalesce(r -> 'content' -> 'meta' ->> 'title', r ->> 'error') from (select public.get_library_paragraph('history', 'h8', 'h8-p1') r) x" 2>&1 | tail -1
}
$P -d $DB -c "select private.admin_grant('KN-FAAAAA', 'premium')" >/dev/null   # бывший F&F купил Premium
GUEST=$($P -d $DB -c "select id from auth.users where is_anonymous limit 1")
check "4. v62-access-check.sql (из инструкции, только чтение): owner/paid/trial → text, expired/none → ACCESS_REQUIRED" \
  "$($P -d $DB -f "$ROOT/supabase/release/v62-access-check.sql" | cut -d'|' -f1,3 | tr '\n' ' ')" "expired|ACCESS_REQUIRED none|ACCESS_REQUIRED owner|text paid|text trial|text "
check "4. владелец → текст" "$(lib "$(uid KN-WAAAAA)")" "ТЕСТ-1"
check "4. пробный период → текст" "$(lib "$(uid KN-TAAAAA)")" "ТЕСТ-1"
check "4. Premium → текст" "$(lib "$(uid KN-FAAAAA)")" "ТЕСТ-1"
check "4. служебный аккаунт с ручным доступом (как раньше) → текст" "$(lib "$(uid KN-MAAAAA)")" "ТЕСТ-1"
check "4. бывший F&F без оплаты (окно закрыто) → ACCESS_REQUIRED" "$(lib "$(uid KN-FBAAAA)")" "ACCESS_REQUIRED"
check "4. гость (анонимный вход) без подписки → ACCESS_REQUIRED" "$(lib "$GUEST")" "ACCESS_REQUIRED"
check "4. без входа (anon) → нет права вызова" "$(lib "" | grep -c 'permission denied')" "1"
$P -d $DB -c "update private.access_grants set starts_at = starts_at - interval '8 days', ends_at = ends_at - interval '8 days' where kind = 'trial'" >/dev/null
check "4. пробный период закончился (по времени сервера) → ACCESS_REQUIRED" "$(lib "$(uid KN-TAAAAA)")" "ACCESS_REQUIRED"

# ---------- 5. восстановление из резервной копии (тестовое окружение) ----------
$P -d postgres -c "create database ${DB}r" >/dev/null
pg_restore $PGD -d ${DB}r --exit-on-error "$OUT/full.dump" 2>"$OUT/restore.err"; RC=$?
check "5. полная копия восстанавливается в пустую базу" "$RC" "0"; [ $RC = 0 ] || head -3 "$OUT/restore.err"
check "5. восстановленная база = состояние до миграции: данные" "$($P -d ${DB}r -c "$DATA")" "$D0"
check "5. восстановленная база = состояние до миграции: функции, права, search_path" "$($P -d ${DB}r -c "$FUNCS")" "$F0"
check "5. восстановленная база = состояние до миграции: таблицы, RLS, политики, права на таблицы и колонки" "$($P -d ${DB}r -c "$RELS")" "$R0"
[ "$($P -d ${DB}r -c "$RELS")" = "$R0" ] || diff "$OUT/r0.txt" <($P -d ${DB}r -c "$RELL") | grep "^[<>]" | sort -k2 | head -6
check "5. восстановлены выдачи, конспекты, бюджет, настройки и панель владельца (число строк)" \
  "$($P -d ${DB}r -c "select (select count(*) from private.access_grants) || '/' || (select count(*) from public.notes) || '/' || (select max_total_starts || ':' || total_starts from private.ai_limits) || '/' || (select count(*) from private.access_settings) || '/' || (select count(*) from private.owner_panel_secrets)")" \
  "2/9/40:10/1/0"
[ "$($P -d ${DB}r -c "$FUNCS")" = "$F0" ] || diff "$OUT/f0.txt" <($P -d ${DB}r -c "$FUNCL") | head -6
check "5. в восстановленной базе нет v62 (таблицы текстов)" "$($P -d ${DB}r -c "select to_regclass('private.library_paragraphs') is null")" "t"
$P -d ${DB}r -v ON_ERROR_STOP=1 -c "truncate private.access_log" >/dev/null
pg_restore $PGD -d ${DB}r --data-only -t access_log "$OUT/data.dump" 2>/dev/null
check "5. точечное восстановление таблицы из копии данных (журнал доступа)" "$($P -d ${DB}r -c "$DATA")" "$D0"
$P -d postgres -c "drop database ${DB}r" >/dev/null

# ---------- 6. откат на копии production ----------
OUTR=$($P -d $DB -v ON_ERROR_STOP=1 -f "$ROOT/supabase/release/rollback-v62.sql" 2>&1); RC=$?
check "6. откат rollback-v62.sql применился" "$RC" "0"; [ $RC = 0 ] || echo "$OUTR" | head -3
check "6. после отката функции = v61.3 (как до миграции)" "$($P -d $DB -c "$FUNCS")" "$F0"
[ "$($P -d $DB -c "$FUNCS")" = "$F0" ] || diff "$OUT/f0.txt" <($P -d $DB -c "$FUNCL") | head -6
check "6. после отката выдачи и конспекты на месте (кроме выданного в тесте Premium — он остаётся)" \
  "$($P -d $DB -c "select count(*) from private.access_grants")/$($P -d $DB -c "select count(*) from public.notes")" "3/9"

# ---------- 7. репетиция v62-local-pg17-check.ps1: ЕГО запросы и фильтр, его порядок шагов ----------
# PowerShell в среде тестов нет: ps1-sql.mjs достаёт SQL из скрипта, здесь он выполняется на копии из шага 1
# (с добавленной схемой vault — как supabase_vault в production: её объекты должны пропускаться).
PS1="$ROOT/supabase/release/v62-local-pg17-check.ps1"
J="$OUT/ps1.json"; node "$HERE/ps1-sql.mjs" "$PS1" > "$J"
js() { node -e 'const j=require(process.argv[1]);const v=j[process.argv[2]];console.log(Array.isArray(v)?v.join("\n"):v)' "$J" "$1"; }
RD=konspekt_v62_restore_t
$P -d postgres -c "drop database if exists ${DB}v" -c "drop database if exists $RD" -c "create database ${DB}v" -c "create database $RD" >/dev/null
pg_restore $PGD -d ${DB}v --exit-on-error "$OUT/full.dump" 2>/dev/null
$P -d ${DB}v -v ON_ERROR_STOP=1 -c "create schema vault" -c "create table vault.secrets (id int, secret text)" \
  -c "insert into vault.secrets values (1, 'секрет')" -c "create function vault.decrypt(t text) returns text language sql as 'select t'" >/dev/null
pg_dump $PGD -d ${DB}v -Fc -f "$OUT/vault.dump"; $P -d ${DB}v -c "$(js struct)" > "$OUT/want.tsv"
$P -d postgres -c "drop database ${DB}v" >/dev/null
cp "$OUT/vault.dump" "$OUT/vault.dump.orig"
check "7. пустая база: проверка пустоты = 0" "$($P -d $RD -c "$(js objs)")" "0"
pg_restore -l "$OUT/vault.dump" > "$OUT/vtoc.txt"
grep -P "$(js skip)" "$OUT/vtoc.txt" > "$OUT/vskip.txt"; grep -vP "$(js skip)" "$OUT/vtoc.txt" > "$OUT/vkeep.txt"
check "7. фильтр оглавления: пропущены ровно объекты vault (схема, таблица, данные, функция), больше ничего" \
  "$(wc -l < "$OUT/vskip.txt" | tr -d ' ')/$(grep -vc ' vault ' "$OUT/vskip.txt")" "4/0"
pg_restore $PGD -d $RD -L "$OUT/vkeep.txt" "$OUT/vault.dump" 2>"$OUT/vrestore.err"; RC=$?
check "7. восстановление без vault: pg_restore без ошибок" "$RC/$(grep -c 'error:' "$OUT/vrestore.err")" "0/0"
check "7. после восстановления база не пустая, объектов vault нет" \
  "$([ "$($P -d $RD -c "$(js objs)")" -gt 0 ] && echo full)/$($P -d $RD -c "select to_regnamespace('vault') is null")" "full/t"
check "7. структура объект в объект = копии (запрос \$structSql скрипта)" "$($P -d $RD -c "$(js struct)" | diff "$OUT/want.tsv" - | grep -c '^[<>]')" "0"
# число строк: COPY-блоки копии (как в скрипте) против запроса скрипта по восстановленной базе
pg_restore -f - --data-only -L "$OUT/vkeep.txt" "$OUT/vault.dump" | awk '/^COPY [^ ]+\.[^ ]+ /{split($2,a,".");gsub(/"/,"",a[1]);gsub(/"/,"",a[2]);cur=a[1]"."a[2];n=0;next} cur!=""{if($0=="\\.") {print cur"\t"n; cur=""} else n++}' | sort > "$OUT/vcopy.tsv"
VALS=$(awk -F'\t' '{split($1,a,"."); printf "%s(\x27%s\x27, \x27%s\x27)", (NR>1?", ":""), a[1], a[2]}' "$OUT/vcopy.tsv")
ROWSQ=$(js rows | sed "s/\$vals/$VALS/")
check "7. число строк каждой таблицы = в копии ($(wc -l < "$OUT/vcopy.tsv" | tr -d ' ') таблиц, без vault)" \
  "$($P -d $RD -c "$ROWSQ" | sort | diff "$OUT/vcopy.tsv" - | grep -c '^[<>]')/$(grep -c '^vault' "$OUT/vcopy.tsv")" "0/0"
$P -d $RD -c "delete from public.notes where id = (select id from public.notes limit 1)" >/dev/null
check "7. пропажа одной строки замечается" "$($P -d $RD -c "$ROWSQ" | sort | diff "$OUT/vcopy.tsv" - | grep -c '^>')" "1"
$P -d postgres -c "drop database $RD" -c "create database $RD" >/dev/null
pg_restore $PGD -d $RD -L "$OUT/vkeep.txt" "$OUT/vault.dump" 2>/dev/null
# функции, которые миграция v62 или откат создают, заменяют, удаляют или переносят: до миграции и после отката они
# должны совпадать с production байт в байт (текст, SECURITY DEFINER, search_path, права) — эталон v62-prod-structure.tsv
TOUCH=$(grep -ohE '(function|on function|procedure) (public|private)\.[a-z0-9_]+' "$M/20261028120000_v62_paid_library.sql" "$ROOT/supabase/release/rollback-v62.sql" | awk '{print $NF}' | sort -u)
touched() { grep -v '^#' | grep -F "$(echo "$TOUCH" | sed 's/$/(/')" | grep -v '^policy' | sort; }
PRODT=$(touched < "$ROOT/supabase/release/v62-prod-structure.tsv")
check "7. функции, которые трогают миграция и откат ($(echo "$PRODT" | wc -l | tr -d ' ') шт.), в копии до миграции = production" \
  "$($P -d $RD -c "$(js struct)" | touched | diff <(echo "$PRODT") - | grep -c '^[<>]')" "0"
# дальше — шаги скрипта: предпроверка, снимок, миграция, снимок, тексты, доступ, повторы, откат
Q() { $P -d $RD -c "$(js q | grep -F "$1" | head -1)"; }
check "7. предпроверка скрипта: панель есть, библиотеки нет, private.plans пустая" "$(Q "private.owner_panel_secrets")" "true|true|0"
F7=$($P -d $RD -c "$(js funcs)"); $P -d $RD -f "$SNAP" > "$OUT/s7a.txt"
$P -d $RD -v ON_ERROR_STOP=1 -f "$M/20261028120000_v62_paid_library.sql" >/dev/null 2>&1; RC=$?
$P -d $RD -f "$SNAP" > "$OUT/s7b.txt"
check "7. миграция на восстановленной копии, данные не изменились" "$RC/$(cmp -s "$OUT/s7a.txt" "$OUT/s7b.txt" && echo same)" "0/same"
check "7. запросы скрипта после миграции: тарифы, права таблицы, права функции" "$(Q "price_label")/$(Q "has_table_privilege('anon'")/$(Q "has_function_privilege('authenticated'")" "gift:7:1:-:false,premium:30:10:299 ₽:true/true|false|false|false/true|false"
$P -d $RD -v ON_ERROR_STOP=1 -f "$OUT/seed.sql" >/dev/null 2>&1
check "7. запросы скрипта после текстов: по предметам, дубли" "$(Q "group by 1) s")/$(Q "count(distinct")" "history:2,physics:1/0"
QERR=$(js q | grep -v '\$' | grep -v '^create' | grep -v 'from (values' | grep -v "then '-1' $" | while IFS= read -r q; do $P -d $RD -c "$q" >/dev/null 2>&1 || echo "ошибка: $q"; done)
[ -n "$QERR" ] && echo "$QERR"
check "7. все запросы-проверки скрипта выполняются без ошибок (на копии после миграции и текстов)" "$(echo -n "$QERR" | grep -c .)" "0"
F8=$($P -d $RD -c "$(js funcs)")
check "7. повтор миграции → код 3, функции те же" "$($P -d $RD -v ON_ERROR_STOP=1 -f "$M/20261028120000_v62_paid_library.sql" >/dev/null 2>&1; echo $?)/$($P -d $RD -c "$(js funcs)")" "3/$F8"
$P -d $RD -v ON_ERROR_STOP=1 -f "$ROOT/supabase/release/rollback-v62.sql" >/dev/null 2>&1; RC=$?; $P -d $RD -f "$SNAP" > "$OUT/s7c.txt"
check "7. откат: функции и данные как до миграции, таблицы текстов нет" \
  "$RC/$([ "$($P -d $RD -c "$(js funcs)")" = "$F7" ] && echo same)/$(cmp -s "$OUT/s7a.txt" "$OUT/s7c.txt" && echo same)/$($P -d $RD -c "$(js q | grep -Fx "select (to_regclass('private.library_paragraphs') is null)::text")")" "0/same/same/true"
check "7. после отката эти функции снова = production (откат возвращает именно версии production)" \
  "$($P -d $RD -c "$(js struct)" | touched | diff <(echo "$PRODT") - | grep -c '^[<>]')" "0"
check "7. копия за репетицию не изменилась" "$(cmp -s "$OUT/vault.dump" "$OUT/vault.dump.orig" && echo same)" "same"
check "7. скрипт: только 127.0.0.1:55432 и база konspekt_v62_restore_20261029, без drop/create/alter, без pg_dump/createdb/dropdb, роли только по ключу" \
  "$(grep -c "^\$DbHost = '127.0.0.1'; \$DbPort = 55432" "$PS1")/$(grep -c "^\$DbName = 'konspekt_v62_restore_20261029'" "$PS1")/$(sed "s/Fail .*//; s/Say .*//" "$PS1" | grep -E '(\bQ |Run )' | grep -ciE "drop |create database|alter (system|role|database)|truncate|dropdb|createdb" | tr -d ' ')/$(grep -cE "Find-Tool '(dropdb|createdb|pg_dump)'" "$PS1")/$(grep -B12 'create role \$r nologin' "$PS1" | grep -c 'if (-not \$CreateMissingRoles)')" "1/1/0/0/1"
$P -d postgres -c "drop database $RD" >/dev/null

echo "ИТОГО: $pass PASS, $fail FAIL"
[ $fail = 0 ]
