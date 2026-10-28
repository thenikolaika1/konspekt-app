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
D0=$($P -d $DB -c "$DATA"); S0=$($P -d $DB -c "$STATE"); F0=$($P -d $DB -c "$FUNCS"); $P -d $DB -c "$FUNCL" > "$OUT/f0.txt"

# ---------- 1. резервная копия до миграции (как backup-before-v62.ps1: полная и только данные) ----------
pg_dump $PGD -d $DB -Fc -f "$OUT/full.dump" && pg_dump $PGD -d $DB -Fc --data-only -t 'public.*' -t 'private.*' -t 'analytics.*' -t auth.users -f "$OUT/data.dump"
check "1. резервные копии сделаны и читаются" "$(pg_restore -l "$OUT/full.dump" >/dev/null && pg_restore -l "$OUT/data.dump" >/dev/null && echo ok)" "ok"

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

echo "ИТОГО: $pass PASS, $fail FAIL"
[ $fail = 0 ]
