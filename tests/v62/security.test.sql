-- v62: аудит прав на копии, где права по умолчанию для новых таблиц схемы public — как в production Supabase
-- (TRUNCATE, REFERENCES, TRIGGER ролям API). Прямые запросы так, как их может отправить кто угодно с ключом
-- приложения: роль anon (без входа) и authenticated (вошедший ученик), а также service_role (Edge Function).
-- Только локальная копия базы (НЕ production). Запуск: tests/v62/run.sh.
\set QUIET on
\pset tuples_only on
\pset format unaligned
set client_min_messages = warning;

create schema t;
create table t.results (n serial, name text, ok boolean, info text);
create function t.ok(p_name text, p_ok boolean, p_info text default null) returns void language sql as
  $$ insert into t.results (name, ok, info) values (p_name, coalesce(p_ok, false), p_info) $$;
create function t.register(p_code text, p_kn text) returns uuid language plpgsql as $$
declare r jsonb; v uuid;
begin
  insert into private.beta_invites (code_hash, quota, expires_at) values (private.invite_code_hash(p_code), 1, now() + interval '7 days');
  r := public.register_invite_begin(p_code, p_kn, repeat('a', 64));
  insert into auth.users (email, raw_app_meta_data) values (private.kn_email(p_kn), jsonb_build_object('kn_reservation', r ->> 'reservation')) returning id into v;
  r := public.register_invite_finish(p_code, (r ->> 'reservation')::uuid, v);
  return v;
end $$;
-- запрос как из браузера: роль и claims JWT; результат — jsonb или {sqlerror}
create function t.as(p_role text, p_uid uuid, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '{"role":"anon"}'
    else jsonb_build_object('sub', p_uid, 'role', p_role, 'is_anonymous', false, 'aal', 'aal1')::text end, true);
  perform set_config('request.method', 'POST', true);
  execute 'set local role ' || p_role;
  execute p_sql into r;
  reset role;
  return coalesce(r, 'null'::jsonb);
exception when others then
  reset role;
  return jsonb_build_object('sqlerror', sqlstate, 'message', sqlerrm);
end $$;
create function t.err(p jsonb) returns text language sql as $$ select p ->> 'sqlerror' $$;
-- команда без результата (TRUNCATE): 'ok' или код ошибки
create function t.run(p_role text, p_sql text) returns text language plpgsql as $$
begin
  execute 'set local role ' || p_role;
  execute p_sql;
  reset role;
  return 'ok';
exception when others then
  reset role;
  return sqlstate;
end $$;

update private.ai_limits set max_total_starts = 100, total_starts = 0, beta_ends_at = now() - interval '1 day' where id;
insert into private.library_paragraphs (subject_id, book_id, paragraph_id, content) values ('history', 'h8', 'p1', '{"meta":{"title":"ТЕСТ-СЕКРЕТ"}}');
select t.register('SECSTUD00001', 'KN-SAAAAA') as ua \gset
select t.register('SECSTUD00002', 'KN-SBAAAA') as ub \gset
select t.register('SECOWNER0001', 'KN-WAAAAA') as uo \gset
select private.admin_set_owner('KN-WAAAAA') ->> 'result' as x \gset
insert into public.notes (user_id, status, stage, title) values (:'ub', 'processing', 'uploading', 'чужой конспект') returning id as nb \gset

-- ======================================================================
-- Схемы, таблицы, функции: что вообще доступно ролям API
-- ======================================================================
select t.ok('S1. схемы private и analytics: у anon, authenticated, service_role нет USAGE', not exists (
  select 1 from unnest(array['private', 'analytics']) s, unnest(array['anon', 'authenticated', 'service_role']) r where has_schema_privilege(r, s, 'usage')));
select t.ok('S2. таблицы private и analytics: ни одного права у ролей API и PUBLIC', not exists (
  select 1 from information_schema.role_table_grants where table_schema in ('private', 'analytics') and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')));
select t.ok('S3. таблицы public: ни у одной роли API нет TRUNCATE, TRIGGER, REFERENCES (в т. ч. от прав по умолчанию)', not exists (
  select 1 from pg_class c, unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['truncate', 'trigger', 'references']) p
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and has_table_privilege(r, c.oid, p)),
  (select string_agg(c.relname || ':' || r || ':' || p, ', ') from pg_class c, unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['truncate', 'trigger', 'references']) p
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and has_table_privilege(r, c.oid, p)));
select t.ok('S3. права по умолчанию в копии действительно как в production (проверка самого теста)', exists (
  select 1 from pg_default_acl d where d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r'
     and array_to_string(d.defaclacl, ',') like '%authenticated=Dxt%'));
select t.ok('S4. все таблицы public — с RLS', not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity));
select t.ok('S4. все таблицы private — с RLS', not exists (select 1 from pg_class c where c.relnamespace = 'private'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity),
  (select string_agg(relname, ',') from pg_class c where c.relnamespace = 'private'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity));
-- точный список функций, которые может вызвать каждая роль
create table t.fx as
  select r, string_agg(p.proname, ',' order by p.proname) fns from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
         unnest(array['anon', 'authenticated', 'service_role']) r
   where n.nspname in ('public', 'private', 'analytics') and has_function_privilege(r, p.oid, 'execute')
     and has_schema_privilege(r, n.oid, 'usage') and n.nspname = 'public' and p.proname not like 't\_%'
   group by r;
select t.ok('S5. anon (без входа) не может вызвать ни одной функции приложения', not exists (select 1 from t.fx where r = 'anon'),
  (select fns from t.fx where r = 'anon'));
select t.ok('S5. authenticated: только get_library_paragraph, get_my_access(_v2), get_plans, track и 19 функций панели owner_*',
  (select fns from t.fx where r = 'authenticated') = 'get_library_paragraph,get_my_access,get_my_access_v2,get_plans,owner_ai,owner_change_password,owner_extend,owner_grant,owner_history,owner_invite_create,owner_invite_revoke,owner_invites,owner_lock,owner_lock_all,owner_overview,owner_panel_setup,owner_panel_state,owner_preview,owner_revoke,owner_set_budget,owner_student,owner_students,owner_unlock,track',
  (select fns from t.fx where r = 'authenticated'));
select t.ok('S5. service_role (Edge Functions): только регистрация и проверка запуска',
  (select fns from t.fx where r = 'service_role') = 'register_invite_begin,register_invite_finish,start_text_generation,start_text_generation_v2',
  (select fns from t.fx where r = 'service_role'));
select t.ok('S6. все SECURITY DEFINER в public/private/analytics — с search_path = '''' и владельцем postgres', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private', 'analytics') and p.prosecdef
     and (not coalesce(p.proconfig @> array['search_path=""'], false) or pg_get_userbyid(p.proowner) <> 'postgres')));
select t.ok('S6. у функций public нет права PUBLIC (только явные роли)', not exists (
  select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not like 't\_%'
     and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))));

-- ======================================================================
-- Прямые запросы ученика (authenticated) и гостя без входа (anon)
-- ======================================================================
select t.ok('A1. ученик: закрытые таблицы (выдачи, бюджет, тексты, пароли панели) — нет доступа (42501)',
  t.err(t.as('authenticated', :'ua', 'select to_jsonb(g) from private.access_grants g limit 1')) = '42501'
  and t.err(t.as('authenticated', :'ua', 'select to_jsonb(l) from private.ai_limits l')) = '42501'
  and t.err(t.as('authenticated', :'ua', 'select to_jsonb(l) from private.library_paragraphs l limit 1')) = '42501'
  and t.err(t.as('authenticated', :'ua', 'select to_jsonb(s) from private.owner_panel_secrets s limit 1')) = '42501');
select t.ok('A2. ученик: выдать себе Premium / поменять лимит / бюджет напрямую — нет доступа',
  t.err(t.as('authenticated', :'ua', 'select private.admin_grant(''KN-SAAAAA'', ''premium'')')) = '42501'
  and t.err(t.as('authenticated', :'ua', 'update private.access_grants set ai_quota = 1000 returning 1')) = '42501'
  and t.err(t.as('authenticated', :'ua', 'update private.ai_limits set max_total_starts = 100000 returning 1')) = '42501'
  and t.err(t.as('authenticated', :'ua', 'select private.admin_grant_trial(''KN-SAAAAA'')')) = '42501');
select t.ok('A3. ученик: запустить генерацию в обход Edge Function (start_text_generation_v2 / v1 / основа) — нет доступа',
  t.err(t.as('authenticated', :'ua', format('select public.start_text_generation_v2(%L, gen_random_uuid())', :'ua'))) = '42501'
  and t.err(t.as('authenticated', :'ua', format('select public.start_text_generation(%L, gen_random_uuid())', :'ua'))) = '42501'
  and t.err(t.as('authenticated', :'ua', format('select private.start_text_generation_v2_base(%L, gen_random_uuid(), 300, 600, 1)', :'ua'))) = '42501');
select t.ok('A4. ученик: чужие конспекты не видны и не удаляются',
  (t.as('authenticated', :'ua', 'select to_jsonb(count(*)) from public.notes where title = ''чужой конспект''')) = '0'::jsonb
  and (t.as('authenticated', :'ua', format('with d as (delete from public.notes where id = %L returning 1) select to_jsonb(count(*)) from d', :'nb'))) = '0'::jsonb
  and exists (select 1 from public.notes where id = :'nb'));
select t.ok('A5. ученик: конспект от чужого имени или сразу «готовый» создать нельзя (RLS)',
  t.err(t.as('authenticated', :'ua', format('insert into public.notes (user_id, status, stage) values (%L, ''processing'', ''uploading'') returning 1', :'ub'))) = '42501'
  and t.err(t.as('authenticated', :'ua', format('insert into public.notes (user_id, status, stage) values (%L, ''ready'', ''done'') returning 1', :'ua'))) = '42501');
insert into public.notes (user_id, status, stage) values (:'ua', 'processing', 'uploading') returning id as na \gset
select t.ok('A6. ученик: сам поставить своему конспекту «готов»/«ошибка» (списать или вернуть генерацию) нельзя — только название',
  t.err(t.as('authenticated', :'ua', format('update public.notes set status = ''failed'' where id = %L returning 1', :'na'))) = '42501'
  and t.err(t.as('authenticated', :'ua', format('update public.notes set content = ''{}''::jsonb where id = %L returning 1', :'na'))) = '42501'
  and (t.as('authenticated', :'ua', format('update public.notes set title = ''моё'' where id = %L returning to_jsonb(1)', :'na'))) = '1'::jsonb);
select t.ok('A7. ученик: TRUNCATE таблиц public (обходит RLS) — нет права',
  t.run('authenticated', 'truncate public.notes') = '42501' and t.run('authenticated', 'truncate public.bookmarks cascade') = '42501'
  and t.run('anon', 'truncate public.bookmark_notes') = '42501' and t.run('authenticated', 'truncate public.ai_generations') = '42501'
  and t.run('service_role', 'truncate public.notes cascade') = '42501'
  and exists (select 1 from public.notes where id = :'nb'));
select t.ok('A8. без входа (anon): текст библиотеки, статус, тарифы, панель — нет права вызова',
  t.err(t.as('anon', null, 'select public.get_library_paragraph(''history'', ''h8'', ''p1'')')) = '42501'
  and t.err(t.as('anon', null, 'select public.get_my_access_v2()')) = '42501'
  and t.err(t.as('anon', null, 'select public.owner_set_budget(''x'', gen_random_uuid(), 1, 1)')) = '42501');
select t.ok('A9. ученик: функции панели без сессии и с чужой — отказ (FORBIDDEN), бюджет и выдачи не меняются',
  t.as('authenticated', :'ua', 'select public.owner_set_budget(''x'', gen_random_uuid(), 500, 100)') ->> 'error' = 'FORBIDDEN'
  and t.as('authenticated', :'ua', 'select public.owner_grant(''x'', gen_random_uuid(), ''KN-SAAAAA'', null, null)') ->> 'error' = 'FORBIDDEN'
  and (select max_total_starts from private.ai_limits) = 100
  and not exists (select 1 from private.access_grants where user_id = :'ua' and kind = 'paid'));
select t.ok('A10. ученик: старая redeem_beta_invite (второй пробный) — нет права вызова',
  t.err(t.as('authenticated', :'ua', 'select public.redeem_beta_invite(''AAAA-BBBB-CCCC'')')) = '42501');
select t.ok('A11. ученик: get_my_access_v2 — только свой статус (ID пользователя не принимается)',
  (select pg_get_function_identity_arguments('public.get_my_access_v2()'::regprocedure)) = ''
  and t.as('authenticated', :'ua', 'select public.get_my_access_v2()') ->> 'status' = 'trial');
select t.ok('A12. ученик: текст библиотеки — только через функцию, при пробном периоде', t.as('authenticated', :'ua',
  'select public.get_library_paragraph(''history'', ''h8'', ''p1'')') -> 'content' -> 'meta' ->> 'title' = 'ТЕСТ-СЕКРЕТ');
select t.ok('A13. ошибка доступа к таблице текстов не раскрывает содержимое', t.as('authenticated', :'ua',
  'select to_jsonb(l) from private.library_paragraphs l') ->> 'message' not like '%ТЕСТ-СЕКРЕТ%');
select t.ok('A14. service_role (Edge Function): тексты библиотеки и выдачи напрямую не читает',
  t.err(t.as('service_role', null, 'select to_jsonb(l) from private.library_paragraphs l limit 1')) = '42501'
  and t.err(t.as('service_role', null, 'select to_jsonb(g) from private.access_grants g limit 1')) = '42501');

select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok and info is not null then ' → ' || left(info, 600) else '' end from t.results order by n;
select 'ИТОГО: ' || count(*) filter (where ok) || ' PASS, ' || count(*) filter (where not ok) || ' FAIL' from t.results;
