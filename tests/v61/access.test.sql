-- Серверные тесты v61 (локальная копия базы, НЕ production). Запуск: psql -v ON_ERROR_STOP=1 -f access.test.sql
\set QUIET on
\pset tuples_only on
\pset format unaligned
set client_min_messages = warning;

create schema t;
create table t.results (n serial, name text, ok boolean, info text);
create function t.ok(p_name text, p_ok boolean, p_info text default null) returns void language sql as
  $$ insert into t.results (name, ok, info) values (p_name, coalesce(p_ok, false), p_info) $$;

-- настройки как в production сейчас: окно F&F 19–24.10, бюджет 40 (занято 7), одна генерация одновременно
update private.ai_limits set beta_starts_at = '2026-10-18 21:00+00', beta_ends_at = '2026-10-23 21:00+00',
  max_total_starts = 40, total_starts = 7, max_in_flight = 1, max_user_starts = 3 where id;

-- ---------- помощники ----------
-- регистрация как в register-invite: код → резерв → пользователь Auth с меткой → завершение (право + триггер)
create function t.register(p_code text, p_kn text) returns uuid language plpgsql as $$
declare r jsonb; v_uid uuid;
begin
  insert into private.beta_invites (code_hash, quota, expires_at) values (private.invite_code_hash(p_code), 1, now() + interval '7 days');
  r := public.register_invite_begin(p_code, p_kn, repeat('a', 64));
  if r ->> 'result' <> 'reserved' then raise exception 'begin: %', r; end if;
  insert into auth.users (email, raw_app_meta_data) values (private.kn_email(p_kn), jsonb_build_object('kn_reservation', r ->> 'reservation'))
    returning id into v_uid;
  r := public.register_invite_finish(p_code, (r ->> 'reservation')::uuid, v_uid);
  if r ->> 'result' <> 'done' then raise exception 'finish: %', r; end if;
  return v_uid;
end $$;
create function t.note(p_uid uuid) returns uuid language sql as
  $$ insert into public.notes (user_id, status, stage) values (p_uid, 'processing', 'uploading') returning id $$;
create function t.start(p_uid uuid, p_note uuid, p_pages int default 2) returns text language plpgsql as $$
declare r jsonb;
begin
  set local role service_role;
  r := public.start_text_generation_v2(p_uid, p_note, 300, 600, p_pages);
  reset role;
  return r ->> 'result';
end $$;
create function t.finish(p_note uuid, p_ok boolean) returns void language sql as
  $$ update public.notes set status = case when p_ok then 'ready' else 'failed' end, stage = case when p_ok then 'done' else 'failed' end where id = p_note $$;
create function t.me(p_uid uuid) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  set local role authenticated;
  r := public.get_my_access_v2();
  reset role;
  return r;
end $$;
-- «прошло время»: сдвигаем сроки выдач пользователя в прошлое (часов сервера не трогаем)
create function t.age(p_uid uuid, p_by interval) returns void language sql as
  $$ update private.access_grants set starts_at = starts_at - p_by, ends_at = ends_at - p_by, created_at = created_at - p_by where user_id = p_uid $$;

-- ======================================================================
-- 1–5. Регистрация, 7 дней, одна генерация, отказ на второй, окончание
-- ======================================================================
select t.register('TESTCODE0001', 'KN-AAAAAA') as u1 \gset
select t.ok('1. регистрация: право beta_invite и ровно одна выдача trial',
  (select count(*) from private.access_grants where user_id = :'u1' and kind = 'trial') = 1
  and exists (select 1 from private.user_entitlements where user_id = :'u1' and source = 'beta_invite'));
select t.ok('2. trial: 7 суток по часам сервера, 1 генерация',
  (select ends_at - starts_at = interval '7 days' and ai_quota = 1 and abs(extract(epoch from starts_at - now())) < 5
     from private.access_grants where user_id = :'u1'));
select t.ok('2. get_my_access_v2: status=trial, ai 1/0/1, server_now есть',
  (select x ->> 'status' = 'trial' and (x ->> 'ai_quota')::int = 1 and (x ->> 'ai_used')::int = 0 and (x ->> 'ai_remaining')::int = 1
          and x ? 'server_now' and x ->> 'ends_at' is not null from (select t.me(:'u1') x) s), (select t.me(:'u1')::text));
select t.ok('2. журнал: trial_on_register', exists (select 1 from private.access_log where user_id = :'u1' and action = 'trial_on_register'));

select t.note(:'u1') as n1 \gset
select t.ok('3. первая генерация пробного периода запускается', t.start(:'u1', :'n1') = 'started');
select t.ok('3. резерв привязан к выдаче trial', (select g.kind from private.usage_ledger l join private.access_grants g on g.id = l.grant_id where l.op_key = :'n1') = 'trial');
select t.note(:'u1') as n2 \gset
select t.ok('20. пока первая идёт: вторая — limit_reached (резерв считается)', t.start(:'u1', :'n2') = 'limit_reached');
select t.finish(:'n1', true);
select t.ok('3. успех → списано (consumed), остаток 0', (select state from private.usage_ledger where op_key = :'n1') = 'consumed'
  and (t.me(:'u1') ->> 'ai_remaining')::int = 0);
select t.start(:'u1', :'n1') as r21 \gset
select t.ok('21. повтор той же note после успеха → ready (без второго списания)', :'r21' = 'ready'
  and (select count(*) from private.usage_ledger where op_key = :'n1') = 1 and (select state from private.usage_ledger where op_key = :'n1') = 'consumed');
select t.ok('4. вторая генерация в пробном периоде → limit_reached', t.start(:'u1', :'n2') = 'limit_reached');

-- неудача возвращает генерацию, но число повторов ограничено (3 запуска на 1 генерацию)
select t.register('TESTCODE0002', 'KN-BBBBBB') as u2 \gset
select t.note(:'u2') as m1 \gset
select t.ok('8a. запуск 1', t.start(:'u2', :'m1') = 'started');
select t.finish(:'m1', false);
select t.ok('8a. ошибка → резерв возвращён, остаток снова 1', (select state from private.usage_ledger where op_key = :'m1') = 'released'
  and (t.me(:'u2') ->> 'ai_available')::int = 1);
select t.start(:'u2', :'m1') as r8 \gset
select t.ok('8a. повтор той же note после ошибки — started (attempts 2)', :'r8' = 'started'
  and (select attempts from private.usage_ledger where op_key = :'m1') = 2);
select t.finish(:'m1', false);
select t.ok('8a. запуск 3', t.start(:'u2', :'m1') = 'started');
select t.finish(:'m1', false);
select t.ok('8a. 4-й запуск при 0 успешных — limit_reached (бесконечных повторов нет)', t.start(:'u2', :'m1') = 'limit_reached');

-- 5. окончание пробного периода
select t.age(:'u1', interval '8 days');
select t.ok('5. через 8 дней: status=expired, kind=trial, остаток 0',
  (select x ->> 'status' = 'expired' and x ->> 'kind' = 'trial' and (x ->> 'ai_remaining')::int = 0 from (select t.me(:'u1') x) s), (select t.me(:'u1')::text));
select t.note(:'u1') as n3 \gset
select t.ok('5. генерация после окончания — access_expired (сервер)', t.start(:'u1', :'n3') = 'access_expired');
select t.ok('8. личные конспекты на месте после окончания', (select count(*) from public.notes where user_id = :'u1') = 3);

-- 22. обход через клиент: часы/JS/localStorage на сервер не влияют; аргументов с чужим uid у клиента нет
select t.ok('22. get_my_access_v2 без аргументов (чужой uid не передать)',
  (select pronargs from pg_proc where proname = 'get_my_access_v2') = 0);

-- ======================================================================
-- 9–13. Ручная выдача, продление, сгорание, отзыв; бывший F&F
-- ======================================================================
select private.admin_grant('kn-aaaaaa', null, 30, 5, 'тест: первая оплата') ->> 'result' as r \gset
select t.ok('9. admin_grant: expired → paid без повторной регистрации', :'r' = 'granted' and t.me(:'u1') ->> 'status' = 'paid'
  and (t.me(:'u1') ->> 'ai_quota')::int = 5);
select t.ok('9. генерация после оплаты — started', t.start(:'u1', :'n3') = 'started');
select t.finish(:'n3', true);
select t.ok('9. списано в счёт paid; trial не затронут', (select g.kind from private.usage_ledger l join private.access_grants g on g.id = l.grant_id where l.op_key = :'n3') = 'paid'
  and (t.me(:'u1') ->> 'ai_used')::int = 1);
do $$ begin perform private.admin_grant('KN-AAAAAA', null, 30, 5); raise exception 'no error'; exception when unique_violation then null; end $$;
select t.ok('9. повторный admin_grant при действующем сроке — отказ (только extend)', true);

-- 10. продление до окончания: новый срок с конца текущего, свой лимит
select (select ends_at from private.access_grants where user_id = :'u1' and kind = 'paid') as end1 \gset
select private.admin_extend('KN-AAAAAA', null, 30, 7, 'тест: продление заранее') ->> 'starts_at' as ext_start \gset
select t.ok('10. продление заранее: новый срок начинается в конце текущего (время не теряется)',
  :'ext_start'::timestamptz = :'end1'::timestamptz);
select t.ok('10. сейчас действует текущий срок: лимит 5, использовано 1; paid_until = конец продления',
  (select (x ->> 'ai_quota')::int = 5 and (x ->> 'ai_used')::int = 1 and (x ->> 'paid_until')::timestamptz = :'end1'::timestamptz + interval '30 days'
     from (select t.me(:'u1') x) s), (select t.me(:'u1')::text));
-- 12. сгорание: переходим во второй срок — лимит 7 «с нуля», остаток первого (4) не прибавляется
select t.age(:'u1', interval '31 days');
select t.ok('12. второй срок: лимит 7, использовано 0 (остаток прежнего не перенесён)',
  (select x ->> 'status' = 'paid' and (x ->> 'ai_quota')::int = 7 and (x ->> 'ai_used')::int = 0 and (x ->> 'ai_remaining')::int = 7 from (select t.me(:'u1') x) s),
  (select t.me(:'u1')::text));
-- 11. продление после окончания: старт сейчас
select t.age(:'u1', interval '31 days');
select t.ok('11. все сроки прошли → expired (kind paid)', t.me(:'u1') ->> 'status' = 'expired' and t.me(:'u1') ->> 'kind' = 'paid');
select private.admin_extend('KN-AAAAAA', null, 30, 3, 'тест: продление после окончания') ->> 'starts_at' as ext2 \gset
select t.ok('11. продление после окончания начинается сейчас', abs(extract(epoch from :'ext2'::timestamptz - now())) < 5
  and t.me(:'u1') ->> 'status' = 'paid' and (t.me(:'u1') ->> 'ai_quota')::int = 3);
-- 13. отзыв
select private.admin_extend('KN-AAAAAA', null, 10, 2, 'тест: будущий срок') ->> 'result' as r \gset
select private.admin_revoke('KN-AAAAAA', 'тест: возврат') as rv \gset
select t.ok('13. admin_revoke: отозваны действующий и будущий сроки', (:'rv'::jsonb ->> 'revoked')::int = 2, :'rv');
select t.ok('13. после отзыва: expired, revoked=true', t.me(:'u1') ->> 'status' = 'expired' and (t.me(:'u1') ->> 'revoked')::boolean);
select t.note(:'u1') as n4 \gset
select t.ok('13. генерация после отзыва — access_expired', t.start(:'u1', :'n4') = 'access_expired');
select t.ok('13. строки выдач и журнал генераций не удалены', (select count(*) from private.access_grants where user_id = :'u1') = 5
  and (select count(*) from private.usage_ledger where user_id = :'u1') >= 2);
select t.ok('журнал: grant, extend×3, revoke', (select count(*) from private.access_log where user_id = :'u1' and action in ('grant','extend','revoke')) = 5);

-- 23. бывший участник F&F: только старое право (как 7 тестировщиков), без выдач
insert into auth.users (email, raw_app_meta_data) values (private.kn_email('KN-FFFFFF'), '{"kn_reservation":"00000000-0000-4000-8000-000000000001"}') returning id as uff \gset
-- старое право F&F как в production (триггер пробного периода тоже сработает на вставку — поэтому выключаем его на время,
-- чтобы воспроизвести аккаунт, созданный до v61)
update private.access_settings set trial_on_register = false;
insert into private.user_entitlements (user_id, resource, plan, quota, source) values (:'uff', 'text_generation', 'beta', 1, 'beta_invite');
update private.access_settings set trial_on_register = true;
select t.ok('23. F&F до v61: выдач нет; статус legacy/expired (окно закрыто)',
  (select x ->> 'status' = 'expired' and x ->> 'kind' = 'legacy' from (select t.me(:'uff') x) s), (select t.me(:'uff')::text));
select t.note(:'uff') as nf \gset
select t.ok('23. F&F: генерация идёт прежней проверкой → access_expired (как сейчас в production)', t.start(:'uff', :'nf') = 'access_expired');
select t.ok('23. пробный период задним числом не выдан', not exists (select 1 from private.access_grants where user_id = :'uff'));
select private.admin_grant('KN-FFFFFF', null, 30, 4, 'тест: F&F оплатил') ->> 'result' as r \gset
select t.ok('23. F&F после оплаты: paid; старая метка/окно не мешают', t.me(:'uff') ->> 'status' = 'paid' and t.start(:'uff', :'nf') = 'started');
select t.finish(:'nf', true);
select t.ok('23. старое право F&F не изменено', (select quota = 1 and source = 'beta_invite' from private.user_entitlements where user_id = :'uff'));

-- ======================================================================
-- 14–15. Владелец; анонимные служебные аккаунты
-- ======================================================================
select t.register('TESTCODE0003', 'KN-CCCCCC') as uo \gset
select private.admin_set_owner('KN-CCCCCC', 'тест: владелец') ->> 'result' as r \gset
select t.ok('14. владелец: status=owner, ends_at=null, ai_quota=null', (select x ->> 'status' = 'owner' and x -> 'ends_at' = 'null'::jsonb and x -> 'ai_quota' = 'null'::jsonb from (select t.me(:'uo') x) s),
  (select t.me(:'uo')::text));
update private.ai_limits set max_total_starts = 1000 where id;
do $$ declare i int; n uuid; u uuid := (select user_id from private.access_grants where kind = 'owner' limit 1); r text;
begin
  for i in 1..5 loop
    n := t.note(u); r := t.start(u, n);
    if r <> 'started' then raise exception 'owner run % → %', i, r; end if;
    perform t.finish(n, true);
  end loop;
end $$;
select t.ok('14. владелец: 5 генераций подряд без личного лимита (больше пробной 1)', (t.me(:'uo') ->> 'ai_used')::int = 5);
update private.ai_limits set max_total_starts = total_starts where id;
select t.note(:'uo') as no1 \gset
select t.ok('15. владелец: общий бюджет исчерпан → ai_paused', t.start(:'uo', :'no1') = 'ai_paused');
update private.ai_limits set max_total_starts = total_starts + 10 where id;
select t.ok('15. владелец: лимит страниц (5 > 4) → too_many_pages', t.start(:'uo', :'no1', 5) = 'too_many_pages');
select t.ok('14. владелец: окончание F&F/пробного не действует (trial при регистрации тоже есть)',
  exists (select 1 from private.access_grants where user_id = :'uo' and kind = 'trial') and t.me(:'uo') ->> 'status' = 'owner');
select private.admin_set_owner('KN-CCCCCC') ->> 'result' as r \gset
select t.ok('14. повторный admin_set_owner — already_owner', :'r' = 'already_owner');
-- анонимный служебный аккаунт (manual, как 2 в production): прежняя логика, без изменений
insert into auth.users (is_anonymous) values (true) returning id as uanon \gset
insert into private.user_entitlements (user_id, resource, plan, quota, source) values (:'uanon', 'text_generation', 'beta', 100, 'manual');
select t.ok('14. анонимный служебный: legacy, status=paid (действует), остаток 100', (select x ->> 'status' = 'paid' and x ->> 'kind' = 'legacy' and (x ->> 'ai_remaining')::int = 100 from (select t.me(:'uanon') x) s),
  (select t.me(:'uanon')::text));
select t.note(:'uanon') as na \gset
select t.ok('14. анонимный служебный: генерация прежней проверкой — started', t.start(:'uanon', :'na') = 'started');
select t.finish(:'na', true);
do $$ begin perform private.admin_set_owner(null); raise exception 'x'; exception when invalid_parameter_value then null; end $$;
select t.ok('14. admin_* не находят анонимных (только KN-ID)', true);

-- ======================================================================
-- 19. Повторное использование приглашения; один пробный период
-- ======================================================================
select (public.register_invite_begin('TESTCODE0001', 'KN-DDDDDD', repeat('b', 64)) ->> 'result') as reuse \gset
select t.ok('19. использованный код — повторная регистрация невозможна', :'reuse' = 'used', :'reuse');
select private.admin_grant_trial('KN-AAAAAA') ->> 'result' as r \gset
select t.ok('19. второй пробный период тому же аккаунту — trial_already_used', :'r' = 'trial_already_used');
select private.admin_grant_trial('KN-FFFFFF', 'тест: механизм переноса F&F') ->> 'result' as r \gset
select t.ok('перенос F&F: admin_grant_trial выдаёт один раз', :'r' = 'trial_granted');

-- ======================================================================
-- Права: роли API не видят ни таблиц, ни функций владельца, ни серверной проверки
-- ======================================================================
do $$
declare f text; r text; denied int := 0; total int := 0;
begin
  for f in select unnest(array[
    'select private.admin_status(''KN-AAAAAA'')', 'select private.admin_grant(''KN-AAAAAA'', null, 1, 1)',
    'select private.admin_extend(''KN-AAAAAA'', null, 1, 1)', 'select private.admin_revoke(''KN-AAAAAA'')',
    'select private.admin_set_owner(''KN-AAAAAA'')', 'select private.admin_grant_trial(''KN-AAAAAA'')',
    'select count(*) from private.access_grants', 'select count(*) from private.plans', 'select count(*) from private.access_log',
    'select private.access_state(gen_random_uuid())',
    'select public.start_text_generation_v2(gen_random_uuid(), gen_random_uuid(), 300, 600, 1)'])
  loop
    foreach r in array array['anon', 'authenticated'] loop
      total := total + 1;
      begin
        execute 'set local role ' || r;
        execute f;
        reset role;
      exception when insufficient_privilege then denied := denied + 1; reset role;
      end;
    end loop;
  end loop;
  perform t.ok('права: anon/authenticated — отказ во всех ' || total || ' вызовах владельца/сервера', denied = total, denied || '/' || total);
end $$;
do $$
declare ok_auth boolean; ok_anon boolean := false;
begin
  set local role authenticated; perform public.get_plans(); ok_auth := true; reset role;
  begin set local role anon; perform public.get_my_access_v2(); reset role; exception when insufficient_privilege then ok_anon := true; reset role; end;
  perform t.ok('права: authenticated — get_my_access_v2/get_plans, anon — нет', ok_auth and ok_anon);
end $$;
select t.ok('права: функции владельца SECURITY INVOKER, публичные — DEFINER с search_path=''''',
  (select bool_and(not prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and proname like 'admin\_%' and proname in ('admin_status','admin_grant','admin_extend','admin_revoke','admin_set_owner','admin_grant_trial','admin_user','admin_terms','admin_lock'))
  and (select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc where proname in ('get_my_access_v2','get_plans','start_text_generation_v2')));
select t.ok('тарифы: справочник пуст, get_plans() = []', (select count(*) from private.plans) = 0 and public.get_plans() = '[]'::jsonb);
insert into private.plans (code, title, days, ai_quota, active) values ('test_plan', 'Тестовый тариф', 30, 9, false);
select t.ok('тарифы: неактивный не показывается', public.get_plans() = '[]'::jsonb);
update private.plans set active = true;
select t.ok('тарифы: активный показывается; admin_grant берёт срок и лимит из тарифа',
  jsonb_array_length(public.get_plans()) = 1
  and (private.admin_grant('KN-BBBBBB', 'test_plan') -> 'status' -> 'access' ->> 'ai_quota')::int = 9);
delete from private.access_grants where plan = 'test_plan'; delete from private.plans;
select t.ok('старые функции v59 не изменены: get_my_access/start_text_generation на месте',
  to_regprocedure('public.get_my_access()') is not null and to_regprocedure('public.start_text_generation(uuid,uuid,integer,integer,integer)') is not null);
select t.ok('старые записи журнала (grant_id NULL) остаются корректными: служебный аккаунт списан по-старому',
  (select grant_id is null and state = 'consumed' from private.usage_ledger where op_key = :'na'));

-- ---------- итог ----------
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok and info is not null then ' → ' || info else '' end from t.results order by n;
select 'ИТОГО: ' || count(*) filter (where ok) || ' PASS, ' || count(*) filter (where not ok) || ' FAIL' from t.results;
