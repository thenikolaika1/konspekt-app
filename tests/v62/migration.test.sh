#!/bin/bash
# v62: миграция на копии «как в production» (v61.3 с учениками, выдачами, генерациями) — данные на месте,
# повторный запуск ничего не меняет, откат возвращает v61.3 и снова применяется v62. Только локально (НЕ production).
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X -tA"
M="$ROOT/supabase/migrations"; V62="$M/20261028120000_v62_paid_library.sql"; RB="$ROOT/supabase/release/rollback-v62.sql"
DB=mg62
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1 → '$2' ожидалось '$3'"; fi; }
$P -d postgres -c "drop database if exists $DB" -c "create database $DB template base61" >/dev/null
$P -d $DB -v ON_ERROR_STOP=1 -f "$M/20261024150000_paid_access.sql" >/dev/null
$P -d $DB -v ON_ERROR_STOP=1 -f "$M/20261026120000_owner_panel.sql" >/dev/null
# данные v61.3: ученики (пробный, оплаченный, служебный без выдач), генерации, журнал, аналитика
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
select public.t_reg('MIGOWNER0001', 'KN-WAAAAA'), public.t_reg('MIGSTUD00001', 'KN-SAAAAA'), public.t_reg('MIGSTUD00002', 'KN-SBAAAA');
select private.admin_set_owner('KN-WAAAAA');
select private.admin_grant('KN-SBAAAA', null, 30, 20, 'оплата до v62');
do $$ declare v uuid; begin
  update private.access_settings set trial_on_register = false;
  insert into auth.users (email) values (private.kn_email('KN-LEGACY')) returning id into v;
  insert into private.user_entitlements (user_id, resource, plan, quota, source) values (v, 'text_generation', 'beta', 1000, 'manual');
  update private.access_settings set trial_on_register = true;
end $$;
update private.ai_limits set max_total_starts = 400, total_starts = 37, max_in_flight = 1 where id;
insert into public.notes (user_id, status, stage) select id, 'ready', 'done' from auth.users;
SQL
FP="select (select count(*) from auth.users) || '|' || (select count(*) from public.notes) || '|' ||
  (select count(*) from private.access_grants) || '|' || (select count(*) from private.user_entitlements) || '|' ||
  (select count(*) from private.access_log) || '|' || (select count(*) from private.generation_starts) || '|' ||
  (select max_total_starts || '/' || total_starts || '/' || max_in_flight from private.ai_limits) || '|' ||
  (select md5(string_agg(g.id::text || g.kind || coalesce(g.plan, '-') || g.ai_quota || g.ends_at, ',' order by g.id)) from private.access_grants g) || '|' ||
  (select md5(string_agg(e.user_id::text || e.source || e.quota, ',' order by e.user_id)) from private.user_entitlements e)"
ST="select string_agg(u.email || '=' || (private.access_state(u.id) ->> 'status') || '/' || coalesce(private.access_state(u.id) ->> 'ai_quota', '-'), ',' order by u.email) from auth.users u"
BEFORE=$($P -d $DB -c "$FP"); SBEFORE=$($P -d $DB -c "$ST")
check "M0. до v62: служебный аккаунт без выдач — paid (legacy), безлимитный по выдачам" "$($P -d $DB -c "select private.access_state(id) ->> 'kind' from auth.users where email = private.kn_email('KN-LEGACY')")" "legacy"

OUT=$($P -d $DB -v ON_ERROR_STOP=1 -f "$V62" 2>&1); check "M1. v62 применилась" "$?" "0"
[ -n "$OUT" ] && echo "$OUT" | head -5
check "M2. ученики, заметки, выдачи, права, журнал, генерации, бюджет — без изменений" "$($P -d $DB -c "$FP")" "$BEFORE"
check "M2. состояния доступа всех участников — те же (служебные аккаунты не тронуты)" "$($P -d $DB -c "$ST")" "$SBEFORE"
check "M3. добавлен тариф premium 30/10/299 ₽, других активных нет" "$($P -d $DB -c "select string_agg(code || '/' || days || '/' || ai_quota || '/' || price_label, ',') from private.plans where active")" "premium/30/10/299 ₽"
check "M3. новые настройки бюджета: k 1.5, резерв владельца 10, предупреждение 20%" "$($P -d $DB -c "select budget_reserve_factor || '/' || owner_reserve_starts || '/' || budget_warn_percent from private.access_settings")" "1.50/10/20"
check "M3. бюджет ИИ после миграции не изменился (новый лимит не задаётся автоматически)" "$($P -d $DB -c "select max_total_starts || '/' || total_starts from private.ai_limits")" "400/37"
OUT=$($P -d $DB -v ON_ERROR_STOP=1 -f "$V62" 2>&1); RC=$?
check "M4. повторный запуск v62 — отказ без изменений" "$RC/$(echo "$OUT" | grep -c 'v62 уже применена')" "3/1"
check "M4. после повторного запуска — всё так же" "$($P -d $DB -c "$FP")" "$BEFORE"
# закрытые тексты: тестовый seed повторяемый
SEED=$(mktemp); cat > "$SEED" <<'SQL'
begin;
insert into private.library_paragraphs as l (subject_id, book_id, paragraph_id, content) values
 ('history', 'h5', 'p1', '{"title":"T1"}'::jsonb), ('physics', 'f7', 'p1', '{"title":"T2"}'::jsonb)
on conflict (subject_id, book_id, paragraph_id) do update set content = excluded.content, updated_at = now()
 where l.content is distinct from excluded.content;
commit;
SQL
$P -d $DB -v ON_ERROR_STOP=1 -f "$SEED" >/dev/null; $P -d $DB -v ON_ERROR_STOP=1 -f "$SEED" >/dev/null; rm -f "$SEED"
check "M5. загрузка текстов дважды — 2 строки, без повторов" "$($P -d $DB -c "select count(*) from private.library_paragraphs")" "2"
# выдача Premium после v62, затем откат
$P -d $DB -c "select private.admin_grant('KN-SAAAAA', 'premium')" >/dev/null
AFTER=$($P -d $DB -c "$FP")
OUT=$($P -d $DB -v ON_ERROR_STOP=1 -f "$RB" 2>&1); check "M6. откат rollback-v62.sql применился" "$?" "0"
[ -n "$OUT" ] && echo "$OUT" | head -5
check "M6. после отката данные (включая выдачу Premium) на месте" "$($P -d $DB -c "$FP")" "$AFTER"
check "M6. после отката: таблицы текстов и функций v62 нет, старая проверка запуска снова в public" \
  "$($P -d $DB -c "select (to_regclass('private.library_paragraphs') is null)::text || (to_regprocedure('public.get_library_paragraph(text,text,text)') is null) || (to_regprocedure('public.owner_set_budget(text,uuid,integer,integer)') is null) || has_function_privilege('service_role', 'public.start_text_generation_v2(uuid,uuid,integer,integer,integer)', 'execute') || (to_regprocedure('public.owner_grant(text,uuid,text,integer,integer,text)') is not null)")" "truetruetruetruetrue"
check "M6. после отката тариф premium выключен, но не удалён" "$($P -d $DB -c "select active from private.plans where code = 'premium'")" "f"
check "M6. функции v61.3 после отката — как в миграции панели (owner_grant без p_custom)" \
  "$($P -d $DB -c "select count(*) from pg_proc where proname in ('owner_grant','owner_extend') and pronamespace = 'public'::regnamespace")" "2"
# функции после отката — те же, что на чистой v61.3 (текст, права, search_path)
REF=mg62ref
$P -d postgres -c "drop database if exists $REF" -c "create database $REF template base61" >/dev/null
$P -d $REF -v ON_ERROR_STOP=1 -f "$M/20261024150000_paid_access.sql" >/dev/null
$P -d $REF -v ON_ERROR_STOP=1 -f "$M/20261026120000_owner_panel.sql" >/dev/null
FN="select md5(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || p.prosrc
  || p.prosecdef || coalesce(array_to_string(p.proconfig, ','), '') || coalesce(array_to_string(p.proacl, ','), ''), '|' order by n.nspname, p.proname))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.proname <> 't_reg'"
check "M6. все функции public/private после отката совпадают с чистой v61.3 (текст, права, search_path)" "$($P -d $DB -c "$FN")" "$($P -d $REF -c "$FN")"
check "M6. колонки access_settings после отката — как в v61.3" \
  "$($P -d $DB -c "select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema = 'private' and table_name = 'access_settings'")" \
  "$($P -d $REF -c "select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema = 'private' and table_name = 'access_settings'")"
OUT=$($P -d $DB -v ON_ERROR_STOP=1 -f "$RB" 2>&1); RC=$?
check "M7. повторный откат — отказ (v62 не применена), без изменений" "$RC/$(echo "$OUT" | grep -c 'откатывать нечего')" "3/1"
# снова v62: тариф premium уже есть, но выключен — миграция должна его принять
OUT=$($P -d $DB -v ON_ERROR_STOP=1 -f "$V62" 2>&1); RC=$?
check "M8. после отката v62 применяется снова" "$RC" "0"
[ "$RC" != 0 ] && echo "$OUT" | head -5
check "M8. тариф premium снова активен" "$($P -d $DB -c "select active from private.plans where code = 'premium'")" "t"
check "M8. данные на месте" "$($P -d $DB -c "$FP")" "$AFTER"
echo "ИТОГО: $pass PASS, $fail FAIL"
[ $fail = 0 ]
