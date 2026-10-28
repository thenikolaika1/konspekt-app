-- v62: закрытая библиотека, тариф Premium, резерв бюджета ИИ, панель (выдача, продление, бюджет).
-- Только локальная копия базы (НЕ production). Тексты — тестовые (не настоящие конспекты), GigaChat не вызывается:
-- запуск генерации — это только серверная проверка start_text_generation_v2, результат ставит тест.
-- Запуск: tests/v62/run.sh (после миграций v61, панели v61.3 и v62).
\set QUIET on
\pset tuples_only on
\pset format unaligned
set client_min_messages = warning;

create schema t;
create table t.results (n serial, name text, ok boolean, info text);
create function t.ok(p_name text, p_ok boolean, p_info text default null) returns void language sql as
  $$ insert into t.results (name, ok, info) values (p_name, coalesce(p_ok, false), p_info) $$;
-- регистрация по коду — как Edge Function register-invite (пробный период выдаётся при регистрации)
create function t.register(p_code text, p_kn text) returns uuid language plpgsql as $$
declare r jsonb; v uuid;
begin
  insert into private.beta_invites (code_hash, quota, expires_at) values (private.invite_code_hash(p_code), 1, now() + interval '7 days');
  r := public.register_invite_begin(p_code, p_kn, repeat('a', 64));
  insert into auth.users (email, raw_app_meta_data) values (private.kn_email(p_kn), jsonb_build_object('kn_reservation', r ->> 'reservation')) returning id into v;
  r := public.register_invite_finish(p_code, (r ->> 'reservation')::uuid, v);
  if r ->> 'result' <> 'done' then raise exception 'finish: %', r; end if;
  return v;
end $$;
create function t.login(p_uid uuid) returns uuid language sql as
  $$ insert into auth.sessions (user_id) values (p_uid) returning id $$;
create table t.ctx (uid uuid, sid uuid, anon boolean default false, method text, noclaims boolean default false);
insert into t.ctx values (null, null);
create function t.as_user(p_uid uuid, p_sid uuid default null, p_anon boolean default false) returns void language sql as
  $$ update t.ctx set uid = p_uid, sid = p_sid, anon = p_anon, noclaims = false, method = 'POST' $$;
-- вызов как браузер: роль authenticated, claims текущего пользователя, метод запроса как у PostgREST
create function t.api(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb; c t.ctx;
begin
  select * into c from t.ctx;
  perform set_config('request.jwt.claims', case when c.noclaims then '{"role":"authenticated"}' else jsonb_build_object('sub', c.uid, 'session_id', c.sid,
    'role', 'authenticated', 'is_anonymous', c.anon, 'aal', 'aal1')::text end, true);
  perform set_config('request.method', coalesce(c.method, ''), true);
  set local role authenticated;
  execute p_sql into r;
  reset role;
  return r;
exception when others then
  reset role;
  return jsonb_build_object('sqlerror', sqlstate, 'message', sqlerrm);
end $$;
create function t.q(p text) returns text language sql immutable as $$ select quote_literal(p) $$;
create function t.lib(p_s text, p_b text, p_p text) returns jsonb language sql as
  $$ select t.api(format('select public.get_library_paragraph(%L, %L, %L)', p_s, p_b, p_p)) $$;
-- генерация: запуск как analyze-pages (service_role) и итог, который записала бы функция
create function t.note(p_uid uuid) returns uuid language sql as
  $$ insert into public.notes (user_id, status, stage) values (p_uid, 'processing', 'uploading') returning id $$;
create function t.start(p_uid uuid, p_note uuid) returns jsonb language plpgsql as $$
declare r jsonb; begin set local role service_role; r := public.start_text_generation_v2(p_uid, p_note, 300, 600, 2); reset role; return r; end $$;
create function t.finish(p_note uuid, p_ok boolean) returns void language sql as
  $$ update public.notes set status = case when p_ok then 'ready' else 'failed' end, stage = case when p_ok then 'done' else 'failed' end,
            error_code = case when p_ok then null else 'AI_BAD_RESPONSE' end where id = p_note $$;
-- новая note: запуск и (если started) итог; возвращает result (+ reason)
create function t.gen(p_uid uuid, p_ok boolean default true) returns text language plpgsql as $$
declare n uuid := t.note(p_uid); r jsonb;
begin r := t.start(p_uid, n); if r ->> 'result' = 'started' then perform t.finish(n, p_ok); end if;
  return (r ->> 'result') || coalesce(':' || (r ->> 'reason'), ''); end $$;
create function t.age(p_uid uuid, p_by interval) returns void language sql as
  $$ update private.access_grants set starts_at = starts_at - p_by, ends_at = ends_at - p_by where user_id = p_uid $$;
create function t.ago_starts(p_by interval) returns void language sql as
  $$ update private.generation_starts set started_at = started_at - p_by, finished_at = finished_at - p_by $$;
create function t.bs() returns jsonb language sql as $$ select private.budget_state() $$;
create function t.bi(p_key text) returns int language sql as $$ select (private.budget_state() ->> p_key)::int $$;
create function t.lim(p_max int, p_total int) returns void language sql as
  $$ update private.ai_limits set max_total_starts = p_max, total_starts = p_total where id $$;

-- окно F&F уже прошло (как в production после беты); общие пределы — как в production
update private.ai_limits set beta_starts_at = '2026-10-18 21:00+00', beta_ends_at = '2026-10-23 21:00+00',
  max_total_starts = 1000, total_starts = 0, max_in_flight = 1, max_user_starts = 3 where id;
create table t.limits_before as select max_in_flight, max_user_starts from private.ai_limits;

-- тестовые тексты (не настоящие конспекты)
insert into private.library_paragraphs (subject_id, book_id, paragraph_id, content) values
  ('history', 'h5', 'p1', '{"title":"ТЕСТ-ИСТОРИЯ-1","sections":[{"h":"x","t":"СЕКРЕТНЫЙ-ТЕКСТ-1"}]}'),
  ('physics', 'f7', 'p2', '{"title":"ТЕСТ-ФИЗИКА-2","sections":[{"h":"y","t":"СЕКРЕТНЫЙ-ТЕКСТ-2"}]}');

-- ===== участники =====
select t.register('OWNERCODE001', 'KN-WAAAAA') as uo \gset
select private.admin_set_owner('KN-WAAAAA', 'тест') ->> 'result' as r \gset
select t.register('TRIALCODE001', 'KN-TAAAAA') as ut \gset
select t.register('PAIDCODE0001', 'KN-PAAAAA') as up \gset
select private.admin_grant('KN-PAAAAA', 'premium') ->> 'result' as r \gset
select t.register('EXPCODE00001', 'KN-EAAAAA') as ue \gset
select private.admin_grant('KN-EAAAAA', 'premium') ->> 'result' as r \gset
select t.age(:'ue', interval '40 days');
select t.register('REVCODE00001', 'KN-RAAAAA') as ur \gset
select private.admin_grant('KN-RAAAAA', 'premium') ->> 'result' as r \gset
select private.admin_revoke('KN-RAAAAA', 'тест', 'paid') ->> 'result' as r \gset
select private.admin_revoke('KN-RAAAAA', 'тест', 'trial') ->> 'result' as r \gset
select t.register('TROLDCODE001', 'KN-XAAAAA') as ux \gset
select t.age(:'ux', interval '8 days');
do $$ declare v uuid; begin
  update private.access_settings set trial_on_register = false;
  insert into auth.users (email) values (private.kn_email('KN-FFAAAA')) returning id into v;
  insert into private.user_entitlements (user_id, resource, plan, quota, source) values (v, 'text_generation', 'beta', 1, 'beta_invite');
  insert into auth.users (email) values (private.kn_email('KN-NAAAAA'));
  update private.access_settings set trial_on_register = true;
  insert into auth.users (is_anonymous) values (true);
end $$;
select id as uf from auth.users where email = private.kn_email('KN-FFAAAA') \gset
select id as un from auth.users where email = private.kn_email('KN-NAAAAA') \gset
select id as ug from auth.users where is_anonymous limit 1 \gset

select t.ok('L0. статусы участников как ожидается: owner, trial, paid, expired×4, none×2',
  (select string_agg(private.access_state(u) ->> 'status', ',' order by i) from unnest(array[:'uo', :'ut', :'up', :'ue', :'ur', :'ux', :'uf', :'un', :'ug']::uuid[]) with ordinality x(u, i))
  = 'owner,trial,paid,expired,expired,expired,expired,none,none',
  (select string_agg(private.access_state(u) ->> 'status', ',' order by i) from unnest(array[:'uo', :'ut', :'up', :'ue', :'ur', :'ux', :'uf', :'un', :'ug']::uuid[]) with ordinality x(u, i)));

-- ======================================================================
-- L. Закрытая библиотека
-- ======================================================================
select t.as_user(:'uo');
select t.ok('L1. владелец получает текст', t.lib('history', 'h5', 'p1') -> 'content' ->> 'title' = 'ТЕСТ-ИСТОРИЯ-1'
  and t.lib('history', 'h5', 'p1') ->> 'access_status' = 'owner');
select t.as_user(:'ut');
select t.ok('L2. пробный период: текст истории и физики', t.lib('history', 'h5', 'p1') -> 'content' ->> 'title' = 'ТЕСТ-ИСТОРИЯ-1'
  and t.lib('physics', 'f7', 'p2') -> 'content' ->> 'title' = 'ТЕСТ-ФИЗИКА-2');
select t.as_user(:'up');
select t.ok('L3. Premium: текст', t.lib('physics', 'f7', 'p2') -> 'content' ->> 'title' = 'ТЕСТ-ФИЗИКА-2'
  and t.lib('physics', 'f7', 'p2') ->> 'access_status' = 'paid');

create table t.denied (who text, r jsonb);
select t.as_user(:'ue');  insert into t.denied select 'expired', t.lib('history', 'h5', 'p1');
select t.as_user(:'ur');  insert into t.denied select 'revoked', t.lib('history', 'h5', 'p1');
select t.as_user(:'ux');  insert into t.denied select 'trial_over', t.lib('history', 'h5', 'p1');
select t.as_user(:'uf');  insert into t.denied select 'ff_over', t.lib('history', 'h5', 'p1');
select t.as_user(:'un');  insert into t.denied select 'none', t.lib('history', 'h5', 'p1');
select t.as_user(:'ug', null, true);  insert into t.denied select 'guest', t.lib('history', 'h5', 'p1');
select t.ok('L4. после срока, отзыв, конец пробного, конец F&F, без доступа, гость → ACCESS_REQUIRED без текста',
  (select count(*) from t.denied where r ->> 'error' = 'ACCESS_REQUIRED' and not r ? 'content'
     and r::text not like '%СЕКРЕТНЫЙ%' and r::text not like '%ТЕСТ-ИСТОРИЯ%') = 6,
  (select string_agg(who || '=' || r::text, '; ') from t.denied));
select t.ok('L4. в отказе — состояние доступа для экрана (expired, revoked)',
  (select r -> 'access' ->> 'status' from t.denied where who = 'expired') = 'expired'
  and (select (r -> 'access' ->> 'revoked')::boolean from t.denied where who = 'revoked'));

-- истечение срока «на лету»: тот же Premium, срок сдвинут — доступ закрывается без выхода из аккаунта
select t.as_user(:'up');
select t.age(:'up', interval '29 days 23 hours');
select t.ok('L5. Premium за час до конца — ещё открыт', t.lib('history', 'h5', 'p1') ? 'content');
select t.age(:'up', interval '2 hours');
select t.ok('L5. Premium через час после конца — ACCESS_REQUIRED', t.lib('history', 'h5', 'p1') ->> 'error' = 'ACCESS_REQUIRED');
select t.age(:'up', interval '-30 days 1 hour');   -- вернуть как было

-- авторизация и метод
update t.ctx set noclaims = true;
select t.ok('L6. без JWT (нет sub) → UNAUTHORIZED', t.lib('history', 'h5', 'p1') ->> 'error' = 'UNAUTHORIZED');
select t.as_user(:'up');
update t.ctx set method = 'GET';
select t.ok('L7. GET (кэшируемый запрос) → METHOD_NOT_ALLOWED, без текста', t.lib('history', 'h5', 'p1') ->> 'error' = 'METHOD_NOT_ALLOWED'
  and not t.lib('history', 'h5', 'p1') ? 'content');
select t.as_user(:'up');
select t.ok('L8. несуществующий параграф и неверные id → NOT_FOUND (одинаково, без подробностей)',
  t.lib('history', 'h5', 'p999') = '{"error":"NOT_FOUND"}'::jsonb
  and t.lib('history', '../x', 'p1') = '{"error":"NOT_FOUND"}'::jsonb
  and t.lib(null, 'h5', 'p1') = '{"error":"NOT_FOUND"}'::jsonb
  and t.lib('HISTORY', 'h5', 'p1') = '{"error":"NOT_FOUND"}'::jsonb
  and t.lib(repeat('a', 300), 'h5', 'p1') = '{"error":"NOT_FOUND"}'::jsonb);
select t.as_user(:'un');
select t.ok('L8. без доступа нельзя узнать, есть ли параграф: и для существующего, и для нет — ACCESS_REQUIRED',
  t.lib('history', 'h5', 'p999') ->> 'error' = 'ACCESS_REQUIRED' and t.lib('history', 'h5', 'p1') ->> 'error' = 'ACCESS_REQUIRED');

-- подмена ID: функция не принимает ID пользователя; sub в claims — только из подписанного JWT
select t.ok('L9. у get_library_paragraph нет параметра пользователя (только предмет, учебник, параграф)',
  (select pg_get_function_identity_arguments('public.get_library_paragraph(text,text,text)'::regprocedure)) = 'p_subject text, p_book text, p_paragraph text');
select t.as_user(:'un');
select t.ok('L9. ученик без доступа не может вызвать access_state чужого ID или прочитать таблицу',
  t.api(format('select private.access_state(%L)', :'up')) ->> 'sqlerror' = '42501'
  and t.api('select to_jsonb(l) from private.library_paragraphs l limit 1') ->> 'sqlerror' = '42501'
  and t.api('select to_jsonb(l) from private.library_paragraphs l limit 1') ->> 'message' not like '%СЕКРЕТ%');

-- права
select t.ok('L10. таблица текстов: RLS включён, ни у одной роли API нет прав на чтение и запись',
  (select relrowsecurity from pg_class where oid = 'private.library_paragraphs'::regclass)
  and not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete']) p
                   where has_table_privilege(r, 'private.library_paragraphs', p))
  and not exists (select 1 from information_schema.role_table_grants where table_schema = 'private' and table_name = 'library_paragraphs'
                   and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')));
select t.ok('L11. get_library_paragraph: SECURITY DEFINER, search_path пустой, владелец postgres, выполнять может только authenticated',
  (select p.prosecdef and p.proconfig @> array['search_path=""'] and pg_get_userbyid(p.proowner) = 'postgres'
     from pg_proc p where p.oid = 'public.get_library_paragraph(text,text,text)'::regprocedure)
  and has_function_privilege('authenticated', 'public.get_library_paragraph(text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.get_library_paragraph(text,text,text)', 'execute')
  and not exists (select 1 from information_schema.role_routine_grants where routine_name = 'get_library_paragraph' and grantee = 'PUBLIC'));
-- ошибка внутри не раскрывает текст: сломанный JSON невозможен (jsonb), а текст выдаётся только целиком в content
select t.ok('L12. ответы-отказы не содержат текста ни в одном случае (проверено: L4, L6–L8)', not exists (
  select 1 from t.denied where r::text like '%СЕКРЕТНЫЙ%'));
select t.ok('L13. все новые функции v62 — с search_path = ''''', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and p.proname in ('get_library_paragraph', 'premium_obligations', 'owner_reserve_left', 'budget_state', 'start_text_generation_v2',
                       'start_text_generation_v2_base', 'panel_ai_state', 'panel_ai_state_base', 'panel_terms', 'panel_budget_check',
                       'panel_error', 'owner_preview', 'owner_grant', 'owner_extend', 'owner_set_budget')
     and not coalesce(p.proconfig @> array['search_path=""'], false)));
select t.ok('L14. прежняя проверка запуска убрана из public и недоступна ролям API; новая — только service_role',
  to_regprocedure('public.start_text_generation_v2_base(uuid,uuid,integer,integer,integer)') is null
  and not has_function_privilege('service_role', 'private.start_text_generation_v2_base(uuid,uuid,integer,integer,integer)', 'execute')
  and has_function_privilege('service_role', 'public.start_text_generation_v2(uuid,uuid,integer,integer,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.start_text_generation_v2(uuid,uuid,integer,integer,integer)', 'execute')
  and not has_function_privilege('anon', 'public.start_text_generation_v2(uuid,uuid,integer,integer,integer)', 'execute'));
-- ======================================================================
-- P. Тариф Premium
-- ======================================================================
select t.ok('P1. тариф premium: Premium, 30 дней, 10 генераций, 299 ₽, активен; единственный активный',
  (select title = 'Premium' and days = 30 and ai_quota = 10 and price_label = '299 ₽' and active from private.plans where code = 'premium')
  and (select count(*) from private.plans where active) = 1);
select t.ok('P1. ученик видит тариф через get_plans (если есть) — цена и срок с сервера',
  coalesce((select (public.get_plans() -> 0 ->> 'price_label') = '299 ₽' where to_regprocedure('public.get_plans()') is not null), true));
select t.ok('P2. выдача по тарифу: 30 дней, 10 генераций, plan_title Premium',
  (select g.plan = 'premium' and g.ai_quota = 10 and g.ends_at - g.starts_at = interval '30 days' from private.access_grants g where g.user_id = :'up' and g.kind = 'paid')
  and private.access_state(:'up') ->> 'plan_title' = 'Premium' and (private.access_state(:'up') ->> 'ai_quota')::int = 10);
select t.ok('P3. пробный период: 7 дней, 1 генерация, один раз на аккаунт',
  (select count(*) = 1 and bool_and(ends_at - starts_at = interval '7 days') and bool_and(ai_quota = 1) from private.access_grants where user_id = :'ut' and kind = 'trial'));
-- успешные считаются, неудачные — нет (побочные действия — отдельными запросами: порядок в AND не гарантирован)
select t.gen(:'up', false) as g1 \gset
select private.access_state(:'up') ->> 'ai_used' as used1 \gset
select t.gen(:'up', true) as g2 \gset
select private.access_state(:'up') as st2 \gset
select t.ok('P4. Premium: неудачная генерация не тратит лимит, успешная — тратит', :'g1' = 'started' and :'used1' = '0'
  and :'g2' = 'started' and (:'st2'::jsonb ->> 'ai_used')::int = 1 and (:'st2'::jsonb ->> 'ai_remaining')::int = 9, :'st2');
select string_agg(t.gen(:'up', true), ',') as g9 from generate_series(1, 9) \gset
select t.gen(:'up', true) as g11 \gset
select t.ok('P5. ещё 9 успешных (всего 10) — все started; 11-я — отказ, лимит Premium исчерпан',
  :'g9' = repeat('started,', 8) || 'started' and :'g11' <> 'started'
  and (private.access_state(:'up') ->> 'ai_remaining')::int = 0, :'g11');
select t.ok('P5. библиотека после исчерпания генераций остаётся открытой до конца срока', (select true from (select t.as_user(:'up')) x)
  and t.lib('history', 'h5', 'p1') ? 'content');
select t.gen(:'ut', true) as gt1 \gset
select t.gen(:'ut', true) as gt2 \gset
select t.ok('P6. пробный: 1 успешная генерация, вторая — отказ', :'gt1' = 'started' and :'gt2' <> 'started', :'gt2');
select t.gen(:'ue', true) as ge \gset
select t.ok('P7. после конца Premium генерации закрыты', :'ge' <> 'started', :'ge');

-- ======================================================================
-- O. Панель: Premium по умолчанию, другие условия, продление, бюджет
-- ======================================================================
select t.login(:'uo') as so \gset
select t.as_user(:'uo', :'so');
select private.admin_panel_setup('KN-WAAAAA') ->> 'setup_code' as code \gset
select t.api('select public.owner_panel_setup(' || t.q(:'code') || ', ''HJKMN-PQRST-23456-WXYZA'')') ->> 'session' as tok \gset
create function t.p(p_sql text) returns jsonb language sql as $$ select t.api(replace(p_sql, '$S', quote_literal(current_setting('t.tok')))) $$;
select set_config('t.tok', :'tok', false) is not null as x \gset
select t.ok('O0. сессия панели получена', :'tok' ~ '^[0-9a-f]{64}$');
select t.register('PANELCODE001', 'KN-SAAAAA') as us \gset
select t.register('PANELCODE002', 'KN-SBAAAA') as us2 \gset

select t.p('select public.owner_preview($S, ''KN-SAAAAA'', ''grant'')') as pv \gset
select t.ok('O1. предпросмотр без параметров — Premium: 30 дней, 10 генераций, plan premium, custom=false, проверка бюджета',
  (:'pv'::jsonb ->> 'days')::int = 30 and (:'pv'::jsonb ->> 'ai_quota')::int = 10 and :'pv'::jsonb ->> 'plan' = 'premium'
  and (:'pv'::jsonb ->> 'custom')::boolean = false and (:'pv'::jsonb -> 'budget_check' ->> 'need')::int = 15
  and (:'pv'::jsonb -> 'budget_check' ->> 'ok')::boolean, :'pv');
select t.p('select public.owner_preview($S, ''KN-SAAAAA'', ''grant'', 30, 10)') as pv2 \gset
select t.ok('O1. 30/10 явно — тоже Premium (не другие условия)', :'pv2'::jsonb ->> 'plan' = 'premium' and (:'pv2'::jsonb ->> 'custom')::boolean = false);
select t.p('select public.owner_preview($S, ''KN-SAAAAA'', ''grant'', 30, 20)') as pv3 \gset
select t.ok('O2. 30/20 — другие условия: custom=true, plan null, бюджет на 30 запусков', (:'pv3'::jsonb ->> 'custom')::boolean
  and :'pv3'::jsonb -> 'plan' = 'null'::jsonb and (:'pv3'::jsonb -> 'budget_check' ->> 'need')::int = 30, :'pv3');
select t.ok('O3. неверные параметры → INVALID_INPUT (0 дней, 401 день, −1 и 1001 генерация)',
  t.p('select public.owner_preview($S, ''KN-SAAAAA'', ''grant'', 0, 10)') ->> 'error' = 'INVALID_INPUT'
  and t.p('select public.owner_preview($S, ''KN-SAAAAA'', ''grant'', 401, 10)') ->> 'error' = 'INVALID_INPUT'
  and t.p('select public.owner_preview($S, ''KN-SAAAAA'', ''grant'', 30, -1)') ->> 'error' = 'INVALID_INPUT'
  and t.p('select public.owner_preview($S, ''KN-SAAAAA'', ''grant'', 30, 1001)') ->> 'error' = 'INVALID_INPUT');
select t.p('select public.owner_grant($S, gen_random_uuid(), ''KN-SAAAAA'', 30, 20)') as gc \gset
select t.ok('O4. выдача с другими условиями без подтверждения → CUSTOM_TERMS_NOT_CONFIRMED, ничего не выдано',
  :'gc'::jsonb ->> 'error' = 'CUSTOM_TERMS_NOT_CONFIRMED'
  and not exists (select 1 from private.access_grants where user_id = :'us' and kind = 'paid'), :'gc');
select t.ok('O4. отказ записан в журнал (panel_refused)', exists (select 1 from private.access_log where action = 'panel_refused'
  and details::text like '%CUSTOM_TERMS_NOT_CONFIRMED%'));
select t.p('select public.owner_grant($S, gen_random_uuid(), ''KN-SAAAAA'', 400, 1000)') as gbad \gset
select t.ok('O4. случайные 400 дней / 1000 генераций без подтверждения не проходят', :'gbad'::jsonb ->> 'error' = 'CUSTOM_TERMS_NOT_CONFIRMED');
select gen_random_uuid() as rq1 \gset
select t.p('select public.owner_grant($S, ' || t.q(:'rq1') || ', ''KN-SAAAAA'', null, null, ''оплата 299'')') as g \gset
select t.ok('O5. выдача Premium по умолчанию: granted, plan premium, 30 дней, 10 генераций, статус paid',
  :'g'::jsonb ->> 'result' = 'granted' and :'g'::jsonb -> 'grant' ->> 'plan' = 'premium'
  and (:'g'::jsonb -> 'grant' ->> 'ai_quota')::int = 10
  and (:'g'::jsonb -> 'grant' ->> 'ends_at')::timestamptz - (:'g'::jsonb -> 'grant' ->> 'starts_at')::timestamptz = interval '30 days'
  and :'g'::jsonb -> 'access' ->> 'status' = 'paid' and :'g'::jsonb -> 'access' ->> 'plan_title' = 'Premium', :'g');
select t.ok('O5. повтор того же запроса — тот же ответ (replayed), одна выдача',
  (t.p('select public.owner_grant($S, ' || t.q(:'rq1') || ', ''KN-SAAAAA'', null, null, ''оплата 299'')') ->> 'replayed')::boolean
  and (select count(*) from private.access_grants where user_id = :'us' and kind = 'paid') = 1);
select t.ok('O5. тот же request_id с другим custom → REQUEST_REUSED',
  t.p('select public.owner_grant($S, ' || t.q(:'rq1') || ', ''KN-SAAAAA'', null, null, ''оплата 299'', true)') ->> 'error' = 'REQUEST_REUSED');
-- досрочное продление: новый срок встык, без переноса остатка
select t.p('select public.owner_preview($S, ''KN-SAAAAA'', ''extend'')') as pe \gset
select t.ok('O6. предпросмотр продления: Premium 30/10, встык к текущему сроку', (:'pe'::jsonb ->> 'starts_after_current')::boolean
  and :'pe'::jsonb ->> 'plan' = 'premium'
  and abs(extract(epoch from (:'pe'::jsonb ->> 'starts_at')::timestamptz - (:'g'::jsonb -> 'grant' ->> 'ends_at')::timestamptz)) < 1, :'pe');
select t.p('select public.owner_extend($S, gen_random_uuid(), ''KN-SAAAAA'', null, null, null, ' || t.q(:'pe'::jsonb ->> 'starts_at') || ')') as e \gset
select private.access_state(:'us') as se \gset
select t.ok('O6. досрочное продление: extended; доступ непрерывен до +60 дней; сейчас по-прежнему 10 генераций (остаток не переносится)',
  :'e'::jsonb ->> 'result' = 'extended' and :'e'::jsonb -> 'grant' ->> 'plan' = 'premium'
  and (:'se'::jsonb ->> 'paid_until')::timestamptz between now() + interval '59 days 23 hours' and now() + interval '60 days 1 hour'
  and (:'se'::jsonb ->> 'ai_quota')::int = 10, :'e');
select t.p('select public.owner_extend($S, gen_random_uuid(), ''KN-SAAAAA'', 30, 20, null, null)') as ec \gset
select t.ok('O7. продление с другими условиями без подтверждения → CUSTOM_TERMS_NOT_CONFIRMED', :'ec'::jsonb ->> 'error' = 'CUSTOM_TERMS_NOT_CONFIRMED', :'ec');
select t.p('select public.owner_grant($S, gen_random_uuid(), ''KN-SBAAAA'', 14, 3, ''скидка'', true)') as g2 \gset
select t.ok('O8. другие условия с подтверждением: выдано, без тарифа (plan null) — в карточке не «Premium»',
  :'g2'::jsonb ->> 'result' = 'granted' and :'g2'::jsonb -> 'grant' -> 'plan' = 'null'::jsonb
  and (:'g2'::jsonb -> 'grant' ->> 'ai_quota')::int = 3 and private.access_state(:'us2') -> 'plan_title' = 'null'::jsonb, :'g2');
select t.ok('O9. старые варианты owner_grant/owner_extend удалены (по одному варианту)',
  (select count(*) from pg_proc where proname = 'owner_grant' and pronamespace = 'public'::regnamespace) = 1
  and (select count(*) from pg_proc where proname = 'owner_extend' and pronamespace = 'public'::regnamespace) = 1);
-- после конца первого срока второй начинается со своих 10 генераций
update private.access_grants set starts_at = starts_at - interval '30 days', ends_at = ends_at - interval '30 days'
 where user_id = :'us' and kind in ('paid', 'trial');
select t.ok('O10. первый срок закончился — действует второй: снова 10 генераций, остаток первого не добавлен',
  (private.access_state(:'us') ->> 'ai_quota')::int = 10 and (private.access_state(:'us') ->> 'ai_used')::int = 0
  and private.access_state(:'us') ->> 'status' = 'paid');

-- ======================================================================
-- B. Бюджет ИИ: резерв под оплаченные генерации
-- ======================================================================
-- сейчас действуют: up (10/10 израсходовано), us (второй срок 10, будущих нет), us2 (3) → O = 0 + 10 + 3 = 13
select t.ok('B1. обязательства O = остаток генераций действующих и будущих оплаченных сроков (0 + 10 + 3)', private.premium_obligations() = 13,
  private.premium_obligations()::text);
select t.p('select public.owner_extend($S, gen_random_uuid(), ''KN-SAAAAA'', null, null, null, ' ||
           t.q((select max(ends_at)::text from private.access_grants where user_id = :'us' and kind = 'paid')) || ')') as e2 \gset
select t.ok('B1. будущий (продлённый заранее) срок тоже в обязательствах: 13 + 10 = 23', :'e2'::jsonb ->> 'result' = 'extended'
  and private.premium_obligations() = 23, :'e2');
select t.ok('B1. закончившийся и отозванный сроки не считаются (ue, ur)',
  not exists (select 1 from private.access_grants g where g.user_id in (:'ue', :'ur') and g.kind = 'paid' and g.revoked_at is null and g.ends_at > now()));
select t.lim(200, 50);
select t.bs() as b1 \gset
select t.ok('B2. состояние: бюджет 200, израсходовано 50, осталось 150, R = ceil(23 × 1.5) = 35, резерв владельца 10, свободно 105',
  (:'b1'::jsonb ->> 'budget')::int = 200 and (:'b1'::jsonb ->> 'used')::int = 50 and (:'b1'::jsonb ->> 'remaining')::int = 150
  and (:'b1'::jsonb ->> 'premium_reserve')::int = 35 and (:'b1'::jsonb ->> 'owner_reserve_left')::int = 10
  and (:'b1'::jsonb ->> 'free')::int = 105 and (:'b1'::jsonb ->> 'factor')::numeric = 1.5, :'b1');
select t.ok('B2. на один новый Premium нужно 15 запусков; можно продать ещё 7; min_budget = 50 + 35; состояние ok',
  (:'b1'::jsonb ->> 'per_premium')::int = 15 and (:'b1'::jsonb ->> 'can_sell')::int = 7
  and (:'b1'::jsonb ->> 'min_budget')::int = 85 and :'b1'::jsonb ->> 'state' = 'ok', :'b1');
select t.ok('B2. панель видит резерв в состоянии ИИ', (t.p('select public.owner_ai($S)') -> 'ai' -> 'reserve' ->> 'premium_reserve')::int = 35
  or (t.p('select public.owner_ai($S)') -> 'reserve' ->> 'premium_reserve')::int = 35, t.p('select public.owner_ai($S)')::text);
-- предупреждение и состояния
select t.lim(200, 170);   -- осталось 30: R 35 → свободно < 0
select t.ok('B3. свободно ≤ 0 → reserved_only', t.bs() ->> 'state' = 'reserved_only' and t.bi('free') < 0, t.bs()::text);
select t.lim(200, 140);   -- осталось 60: свободно 15, 15*100 < 200*20 → low
select t.ok('B3. свободно меньше 20% бюджета → low', t.bs() ->> 'state' = 'low' and t.bi('free') = 15, t.bs()::text);
select t.lim(200, 200);
select t.ok('B3. ничего не осталось → exhausted', t.bs() ->> 'state' = 'exhausted');

-- пробный не тратит резерв Premium
select t.register('BUDTRIAL0001', 'KN-BAAAAA') as ub1 \gset
select t.register('BUDTRIAL0002', 'KN-BBAAAA') as ub2 \gset
-- осталось ровно R + резерв владельца = 35 + 10 = 45: пробный запуск уже не помещается
select t.lim(200, 155);
select total_starts as tot0, (select count(*) from private.generation_starts) as gs0, (select count(*) from private.usage_ledger) as ul0
  from private.ai_limits \gset
select t.note(:'ub1') as nb1 \gset
select t.start(:'ub1', :'nb1') as rb1 \gset
select t.ok('B4. пробный при остатке = резерв Premium + владельца → ai_paused (premium_reserve)',
  :'rb1'::jsonb ->> 'result' = 'ai_paused' and :'rb1'::jsonb ->> 'reason' = 'premium_reserve', :'rb1');
select t.ok('B4. отказ ничего не оставил: счётчик, журнал запусков, учёт генераций и note — как до запуска',
  (select total_starts from private.ai_limits) = :tot0 and (select count(*) from private.generation_starts) = :gs0
  and (select count(*) from private.usage_ledger) = :ul0
  and (select status = 'processing' and stage = 'uploading' from public.notes where id = :'nb1'),
  (select row_to_json(n)::text from public.notes n where id = :'nb1'));
select t.ok('B4. у пробного генерация осталась (не потрачена отказом)', (private.access_state(:'ub1') ->> 'ai_available')::int = 1);
select t.lim(200, 154);   -- на один запуск больше: помещается
select t.gen(:'ub1', true) as rb1b \gset
select t.ok('B5. на один запуск больше резерва → пробный started', :'rb1b' = 'started', :'rb1b');
select t.ok('B5. и тут же следующий пробный — снова ai_paused (запас ровно исчерпан)', t.gen(:'ub2', true) = 'ai_paused:premium_reserve');
-- Premium при том же остатке запускается: его генерации и есть резерв
select t.gen(:'us', true) as rp \gset
select t.ok('B6. Premium при остатке «только резерв» → started', :'rp' = 'started', :'rp');
-- владелец: свой резерв может тратить, резерв Premium — нет
select (select max_total_starts - total_starts from private.ai_limits) as rem_now, t.bi('premium_reserve') as rr \gset
select t.lim(200, 200 - (:rr + 2));
select t.gen(:'uo', true) as ro1 \gset
select t.gen(:'uo', true) as ro2 \gset
select t.gen(:'uo', true) as ro3 \gset
select t.ok('B7. владелец: 2 запуска из резерва владельца — started, третий упирается в резерв Premium',
  :'ro1' = 'started' and :'ro2' = 'started' and :'ro3' = 'ai_paused:premium_reserve', :'ro1' || ',' || :'ro2' || ',' || :'ro3');
select t.ok('B7. резерв владельца уменьшился на 2 (за 30 дней)', t.bi('owner_reserve_left') = 8, t.bs()::text);
select t.ago_starts(interval '31 days');
select t.ok('B7. через 30 дней резерв владельца снова полный', t.bi('owner_reserve_left') = 10);
-- неудачная генерация Premium не уменьшает обязательства, успешная — уменьшает на 1
select t.lim(1000, 0);
select private.premium_obligations() as o0 \gset
select t.gen(:'us', false) as rf \gset
select private.premium_obligations() as o1 \gset
select t.gen(:'us', true) as rs \gset
select t.ok('B8. Premium: неудача — обязательства те же, успех — на 1 меньше', :'rf' = 'started' and :'rs' = 'started'
  and :o1 = :o0 and private.premium_obligations() = :o0 - 1, :o0 || '/' || :o1 || '/' || private.premium_obligations());
select t.ok('B8. max_in_flight и max_user_starts не изменены', (select max_in_flight = 1 and max_user_starts = 3 from private.ai_limits)
  and (select row(max_in_flight, max_user_starts) from private.ai_limits) = (select row(max_in_flight, max_user_starts) from t.limits_before));

-- новая выдача проверяет бюджет
select t.register('BUDGRANT0001', 'KN-GAAAAA') as ugr \gset
select t.lim(100, 100 - (t.bi('premium_reserve') + t.bi('owner_reserve_left') + 14));   -- свободно 14 < 15
select t.p('select public.owner_preview($S, ''KN-GAAAAA'', ''grant'')') as pb \gset
select t.ok('B9. предпросмотр: бюджета не хватает (нужно 15, свободно 14)', not (:'pb'::jsonb -> 'budget_check' ->> 'ok')::boolean
  and (:'pb'::jsonb -> 'budget_check' ->> 'free')::int = 14, :'pb');
select t.p('select public.owner_grant($S, gen_random_uuid(), ''KN-GAAAAA'', null, null)') as gb \gset
select t.ok('B9. выдача → BUDGET_LOW (need 15, free 14), Premium не выдан', :'gb'::jsonb ->> 'error' = 'BUDGET_LOW'
  and (:'gb'::jsonb ->> 'need')::int = 15 and (:'gb'::jsonb ->> 'free')::int = 14
  and not exists (select 1 from private.access_grants where user_id = :'ugr' and kind = 'paid'), :'gb');
select t.p('select public.owner_grant($S, gen_random_uuid(), ''KN-GAAAAA'', 30, 9, null, true)') as gb9 \gset
select t.ok('B9. меньший лимит (9 → нужно 14) помещается', :'gb9'::jsonb ->> 'result' = 'granted', :'gb9');
select t.p('select public.owner_extend($S, gen_random_uuid(), ''KN-SAAAAA'', null, null, null, ' ||
           t.q((select max(ends_at)::text from private.access_grants where user_id = :'us' and kind = 'paid')) || ')') as eb \gset
select t.ok('B10. продление тоже проверяет бюджет → BUDGET_LOW', :'eb'::jsonb ->> 'error' = 'BUDGET_LOW', :'eb');

-- изменение бюджета владельцем
select t.lim(100, 40);
select t.bi('min_budget') as minb \gset
select t.p('select public.owner_set_budget($S, gen_random_uuid(), ' || (:minb - 1) || ', 100)') as sb1 \gset
select t.ok('B11. бюджет ниже «израсходовано + резерв Premium» → BUDGET_TOO_LOW с минимумом', :'sb1'::jsonb ->> 'error' = 'BUDGET_TOO_LOW'
  and (:'sb1'::jsonb ->> 'min')::int = :minb and (select max_total_starts from private.ai_limits) = 100, :'sb1');
select t.p('select public.owner_set_budget($S, gen_random_uuid(), 150, 99)') as sb2 \gset
select t.ok('B11. владелец видел другой бюджет → STATE_CHANGED', :'sb2'::jsonb ->> 'error' = 'STATE_CHANGED', :'sb2');
select t.ok('B11. неверные значения → INVALID_INPUT (−1, 100001, null)',
  t.p('select public.owner_set_budget($S, gen_random_uuid(), -1, 100)') ->> 'error' = 'INVALID_INPUT'
  and t.p('select public.owner_set_budget($S, gen_random_uuid(), 100001, 100)') ->> 'error' = 'INVALID_INPUT'
  and t.p('select public.owner_set_budget($S, gen_random_uuid(), null, 100)') ->> 'error' = 'INVALID_INPUT');
select gen_random_uuid() as rqb \gset
select t.p('select public.owner_set_budget($S, ' || t.q(:'rqb') || ', 150, 100)') as sb3 \gset
select t.ok('B12. бюджет 100 → 150: budget_set, записано в журнал, в ответе новое состояние', :'sb3'::jsonb ->> 'result' = 'budget_set'
  and (select max_total_starts from private.ai_limits) = 150
  and exists (select 1 from private.access_log where action = 'budget' and (details ->> 'from')::int = 100 and (details ->> 'to')::int = 150)
  and (:'sb3'::jsonb -> 'ai' -> 'reserve' ->> 'budget')::int = 150, :'sb3');
select t.ok('B12. повтор того же запроса — replayed, бюджет не меняется второй раз',
  (t.p('select public.owner_set_budget($S, ' || t.q(:'rqb') || ', 150, 100)') ->> 'replayed')::boolean
  and (select count(*) from private.access_log where action = 'budget') = 1);
select t.p('select public.owner_set_budget($S, gen_random_uuid(), ' || :minb || ', 150)') as sb4 \gset
select t.ok('B12. ровно минимум разрешён', :'sb4'::jsonb ->> 'result' = 'budget_set', :'sb4');
update t.ctx set method = 'GET';
select t.ok('B13. GET → METHOD_NOT_ALLOWED', t.p('select public.owner_set_budget($S, gen_random_uuid(), 500, 150)') ->> 'error' = 'METHOD_NOT_ALLOWED');
update t.ctx set method = 'POST';
select t.ok('B13. без сессии панели → PANEL_LOCKED', t.api('select public.owner_set_budget(null, gen_random_uuid(), 500, 150)') ->> 'error' = 'PANEL_LOCKED');
select t.login(:'ut') as st \gset
select t.as_user(:'ut', :'st');
select t.ok('B13. ученик → FORBIDDEN', t.p('select public.owner_set_budget($S, gen_random_uuid(), 500, 150)') ->> 'error' = 'FORBIDDEN',
  t.p('select public.owner_set_budget($S, gen_random_uuid(), 500, 150)')::text);
select t.as_user(:'ug', null, true);
select t.ok('B13. гость → FORBIDDEN', t.api('select public.owner_set_budget(''x'', gen_random_uuid(), 500, 150)') ->> 'error' = 'FORBIDDEN');
select t.ok('B13. ни одна из попыток не изменила бюджет', (select max_total_starts from private.ai_limits) = :minb);
select t.ok('B14. автоматически бюджет нигде не меняется: max_total_starts меняют только owner_set_budget и admin-функции',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname in ('public', 'private') and p.prosrc ilike '%set max_total_starts%'
                 and p.proname not in ('owner_set_budget')));

-- ======================================================================
-- Итог
-- ======================================================================
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok and info is not null then ' → ' || left(info, 600) else '' end from t.results order by n;
select 'ИТОГО: ' || count(*) filter (where ok) || ' PASS, ' || count(*) filter (where not ok) || ' FAIL' from t.results;
