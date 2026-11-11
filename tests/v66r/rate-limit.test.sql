-- v66: ограничение частоты get_library_paragraph — только локальная копия базы (НЕ production).
-- Запуск: tests/v66r/rate-limit.test.sh
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
create function t.lib(p_uid uuid, p_par text) returns jsonb language sql as
  $$ select t.as('authenticated', p_uid, format('select public.get_library_paragraph(%L, %L, %L)', 'history', 'h8', p_par)) $$;

update private.ai_limits set max_total_starts = 100, total_starts = 0, beta_ends_at = now() - interval '1 day' where id;
insert into private.library_paragraphs (subject_id, book_id, paragraph_id, content)
  select 'history', 'h8', 'p' || i, jsonb_build_object('meta', jsonb_build_object('title', 'ТЕКСТ ' || i)) from generate_series(1, 90) i;
select t.register('RLSTUD000001', 'KN-RAAAAA') as ua \gset
select t.register('RLSTUD000002', 'KN-RBAAAA') as ub \gset
select t.register('RLOWNER00001', 'KN-RWAAAA') as uo \gset
select t.register('RLNONE000001', 'KN-RNAAAA') as un \gset
select private.admin_set_owner('KN-RWAAAA') ->> 'result' as x \gset
-- ученикам A и B — пробный период; N — без доступа
select t.ok('R0. у учеников A и B есть доступ (пробный период после регистрации), у владельца — owner',
  private.access_state(:'ua') ->> 'status' in ('trial', 'paid') and private.access_state(:'ub') ->> 'status' in ('trial', 'paid')
  and private.access_state(:'uo') ->> 'status' = 'owner', private.access_state(:'ua')::text);

-- 1. первые 20 новых параграфов за час — выдаются
select t.ok('R1. 20 новых параграфов подряд — все выдаются с текстом',
  (select bool_and(t.lib(:'ua', 'p' || i) -> 'content' -> 'meta' ->> 'title' = 'ТЕКСТ ' || i) from generate_series(1, 20) i));
select t.ok('R2. 21-й новый параграф за час — RATE_LIMITED, текста в ответе нет',
  t.lib(:'ua', 'p21') ->> 'error' = 'RATE_LIMITED' and t.lib(:'ua', 'p21') -> 'content' is null and (t.lib(:'ua', 'p21') ->> 'retry_after')::int = 3600,
  t.lib(:'ua', 'p21')::text);
select t.ok('R3. уже открытый параграф открывается повторно без ограничения (перечитывание)',
  t.lib(:'ua', 'p5') -> 'content' -> 'meta' ->> 'title' = 'ТЕКСТ 5');
select t.ok('R4. лимит считается отдельно для каждого ученика: B получает новые параграфы',
  t.lib(:'ub', 'p21') -> 'content' -> 'meta' ->> 'title' = 'ТЕКСТ 21');
select t.ok('R5. владелец — без ограничения: 40 параграфов подряд, в журнал не пишется',
  (select bool_and(t.lib(:'uo', 'p' || i) ? 'content') from generate_series(1, 40) i)
  and not exists (select 1 from private.library_reads where user_id = :'uo'));
update private.access_grants set ends_at = now() - interval '1 day', starts_at = now() - interval '8 days' where user_id = :'un';
select t.ok('R6. без доступа — по-прежнему ACCESS_REQUIRED (лимит не раскрывает ничего нового)',
  t.lib(:'un', 'p1') ->> 'error' = 'ACCESS_REQUIRED');
select t.ok('R7. несуществующий параграф — NOT_FOUND и не тратит лимит',
  t.lib(:'ub', 'zz') ->> 'error' = 'NOT_FOUND' and not exists (select 1 from private.library_reads where user_id = :'ub' and paragraph_id = 'zz'));
-- 2. через час — снова можно (сдвигаем время записей), суточный предел 60
update private.library_reads set read_at = read_at - interval '61 minutes' where user_id = :'ua';
select t.ok('R8. через час — новые параграфы снова выдаются',
  t.lib(:'ua', 'p21') ? 'content');
update private.library_reads set read_at = now() - interval '2 hours' where user_id = :'ua';
insert into private.library_reads (user_id, subject_id, book_id, paragraph_id, read_at)
  select :'ua', 'history', 'h8', 'x' || i, now() - interval '3 hours' from generate_series(1, 39) i;
select t.ok('R9. 60 новых параграфов за сутки — дальше RATE_LIMITED с retry_after = 86400',
  t.lib(:'ua', 'p30') ->> 'error' = 'RATE_LIMITED' and (t.lib(:'ua', 'p30') ->> 'retry_after')::int = 86400, t.lib(:'ua', 'p30')::text);
delete from private.library_reads where user_id = :'ua';
insert into private.library_reads (user_id, subject_id, book_id, paragraph_id, read_at) values (:'ua', 'history', 'h8', 'p2', now() - interval '25 hours');
select t.lib(:'ua', 'p2') ? 'content' as r10a \gset
select t.ok('R10. параграф, открытый больше суток назад, выдаётся и время чтения обновляется',
  :'r10a' and (select read_at > now() - interval '1 minute' from private.library_reads where user_id = :'ua' and paragraph_id = 'p2'));
-- 3. права
select t.ok('R11. журнал чтений не доступен ролям API (anon, authenticated, service_role)',
  not has_table_privilege('anon', 'private.library_reads', 'SELECT') and not has_table_privilege('authenticated', 'private.library_reads', 'SELECT')
  and not has_table_privilege('authenticated', 'private.library_reads', 'INSERT') and not has_table_privilege('service_role', 'private.library_reads', 'SELECT')
  and (select relrowsecurity from pg_class where oid = 'private.library_reads'::regclass));
select t.ok('R12. права на функцию прежние: anon — нет, authenticated — да',
  not has_function_privilege('anon', 'public.get_library_paragraph(text,text,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_library_paragraph(text,text,text)', 'EXECUTE'));
select t.ok('R13. ученик не может сбросить лимит: прямое удаление из журнала запрещено',
  t.as('authenticated', :'ua', 'select to_jsonb(count(*)) from (delete from private.library_reads returning 1) x') ? 'sqlerror');
select set_config('request.jwt.claims', jsonb_build_object('sub', :'ua', 'role', 'authenticated')::text, false) as x \gset
select set_config('request.method', 'GET', false) as x \gset
select public.get_library_paragraph('history', 'h8', 'p1') ->> 'error' as r14 \gset
select set_config('request.method', 'POST', false) as x \gset
select t.ok('R14. GET-запрос (не POST) — METHOD_NOT_ALLOWED, как раньше', :'r14' = 'METHOD_NOT_ALLOWED', :'r14');

-- 4. v66: обход и платные ученики
insert into auth.users (is_anonymous) values (true) returning id as uanon \gset
select t.ok('R15. новый анонимный аккаунт (смена device ID) — ACCESS_REQUIRED: доступа к библиотеке нет, обойти лимит нельзя',
  t.lib(:'uanon', 'p50') ->> 'error' = 'ACCESS_REQUIRED' and not exists (select 1 from private.library_reads where user_id = :'uanon'));
select t.register('RLPAID000001', 'KN-RPAAAA') as up \gset
update private.access_grants set ends_at = now() - interval '1 second', starts_at = now() - interval '8 days' where user_id = :'up' and kind = 'trial';
insert into private.access_grants (user_id, kind, starts_at, ends_at, ai_quota, granted_by, note)
  values (:'up', 'paid', now() - interval '1 day', now() + interval '30 days', 10, 'owner', 'test premium');
select t.ok('R16. Premium: 20 новых параграфов за час выдаются, 21-й — RATE_LIMITED (тот же лимит, что у пробного)',
  private.access_state(:'up') ->> 'status' = 'paid'
  and (select bool_and(t.lib(:'up', 'p' || i) ? 'content') from generate_series(31, 50) i)
  and t.lib(:'up', 'p51') ->> 'error' = 'RATE_LIMITED', private.access_state(:'up')::text);
select t.ok('R17. Premium после лимита: доступ не потерян — статус paid, срок прежний, открытые параграфы читаются',
  private.access_state(:'up') ->> 'status' = 'paid' and t.lib(:'up', 'p40') -> 'content' -> 'meta' ->> 'title' = 'ТЕКСТ 40'
  and (select count(*) from private.access_grants where user_id = :'up' and kind = 'paid' and revoked_at is null and ends_at > now() + interval '29 days') = 1);
select t.ok('R18. ответ RATE_LIMITED не содержит текста и сведений о доступе',
  (select count(*) from jsonb_object_keys(t.lib(:'up', 'p52'))) = 2);

select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when ok or info is null then '' else ' → ' || info end from t.results order by n;
select 'ИТОГО: ' || count(*) filter (where ok) || ' PASS, ' || count(*) filter (where not ok) || ' FAIL' from t.results;
