-- v61.1: защита общего бюджета ИИ от повторов и правило отзыва во время пробного периода.
-- Только локальная копия базы (НЕ production). Запуск: run.sh (после миграции).
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
  if r ->> 'result' <> 'done' then raise exception 'finish: %', r; end if;
  return v;
end $$;
create function t.note(p_uid uuid) returns uuid language sql as
  $$ insert into public.notes (user_id, status, stage) values (p_uid, 'processing', 'uploading') returning id $$;
create function t.start(p_uid uuid, p_note uuid, p_pages int default 2) returns text language plpgsql as $$
declare r jsonb; begin set local role service_role; r := public.start_text_generation_v2(p_uid, p_note, 300, 600, p_pages); reset role; return r ->> 'result'; end $$;
create function t.finish(p_note uuid, p_ok boolean) returns void language sql as
  $$ update public.notes set status = case when p_ok then 'ready' else 'failed' end, stage = case when p_ok then 'done' else 'failed' end where id = p_note $$;
create function t.me(p_uid uuid) returns jsonb language plpgsql as $$
declare r jsonb; begin perform set_config('request.jwt.claim.sub', p_uid::text, true); set local role authenticated; r := public.get_my_access_v2(); reset role; return r; end $$;
-- «прошли сутки» для журнала запусков пользователя
create function t.day_passes(p_uid uuid) returns void language plpgsql as
  $$ begin update private.generation_starts set started_at = started_at - interval '25 hours', finished_at = finished_at - interval '25 hours' where user_id = p_uid; end $$;
-- «прошло время» для выдач пользователя
create function t.age(p_uid uuid, p_by interval) returns void language plpgsql as
  $$ begin update private.access_grants set starts_at = starts_at - p_by, ends_at = ends_at - p_by where user_id = p_uid; end $$;
-- серия неудачных запусков новой note каждый раз; возвращает, на чём остановилось
create function t.fail_loop(p_uid uuid, p_max int) returns text language plpgsql as $$
declare i int; n uuid; r text;
begin
  for i in 1..p_max loop n := t.note(p_uid); r := t.start(p_uid, n); if r <> 'started' then return i || ':' || r; end if; perform t.finish(n, false); end loop;
  return 'all_started';
end $$;
create function t.budget() returns int language sql as $$ select total_starts from private.ai_limits $$;

update private.ai_limits set beta_starts_at = '2026-10-18 21:00+00', beta_ends_at = '2026-10-23 21:00+00',
  max_total_starts = 1000, total_starts = 7, max_in_flight = 1, max_user_starts = 3 where id;

-- ======================================================================
-- 1. Злоупотребление повторами: платный срок с лимитом 20
-- ======================================================================
select t.register('BUDGETCODE01', 'KN-PAAAAA') as up \gset
select private.admin_grant('KN-PAAAAA', null, 30, 20, 'тест') ->> 'result' as r \gset
select t.budget() as b0 \gset
select t.fail_loop(:'up', 50) as stop1 \gset
select t.ok('B1. неудачи подряд: 3-й запуск за сутки — retry_limit (было: 60 запусков)', :'stop1' = '3:retry_limit', :'stop1');
select t.ok('B1. общий бюджет потрачен только на 2 неудачи', t.budget() - :b0 = 2, (t.budget() - :b0)::text);
select t.ok('B1. неудачи не тратят генерации срока (20 из 20 доступны)', (t.me(:'up') ->> 'ai_available')::int = 20);
-- 20 «суток» подряд по 2 неудачи: предел на срок = max(3, 20) = 20 неудач
do $$ declare d int; u uuid := (select id from auth.users where email = private.kn_email('KN-PAAAAA'));
begin for d in 1..15 loop perform t.day_passes(u); perform t.fail_loop(u, 5); end loop; end $$;
select t.ok('B2. за весь срок — не больше 20 неудач (= лимиту срока), дальше retry_limit каждый день',
  (select private.failed_starts(id, '-infinity', null) from auth.users where email = private.kn_email('KN-PAAAAA')) = 20
  and t.fail_loop(:'up', 1) = '1:retry_limit');
select t.ok('B2. общий бюджет на неудачи одного ученика ограничен 20 (было бы 60)', t.budget() - :b0 = 20, (t.budget() - :b0)::text);
-- успешная генерация после исчерпания неудач тоже ждёт: retry_limit блокирует все запуски этого срока
select t.ok('B3. при исчерпанном пределе неудач запуск не начинается (успех тоже) — защита бюджета', t.start(:'up', t.note(:'up')) = 'retry_limit');
-- новый срок (продление) — свой предел неудач
select private.admin_revoke('KN-PAAAAA') ->> 'result' as r \gset
select private.admin_grant('KN-PAAAAA', null, 30, 5) ->> 'result' as r \gset
select t.day_passes(:'up');
select t.ok('B4. новый срок: неудачи прежнего срока не мешают (свой предел)', t.start(:'up', t.note(:'up')) = 'started');
update private.usage_ledger set state = 'released', finalized_at = now() where state = 'reserved';
update private.generation_starts set outcome = 'failed', finished_at = now() where outcome is null;

-- ======================================================================
-- 2. Пробный период: 1 успех + не больше 3 неудач, 2 в сутки
-- ======================================================================
select t.register('BUDGETCODE02', 'KN-TAAAAA') as ut \gset
select t.budget() as b1 \gset
select t.fail_loop(:'ut', 10) as s1 \gset
select t.day_passes(:'ut');
select t.fail_loop(:'ut', 10) as s2 \gset
select t.day_passes(:'ut');
select t.fail_loop(:'ut', 10) as s3 \gset
select t.ok('B5. пробный: 2 неудачи в 1-й день, 1 во 2-й, дальше retry_limit', :'s1' = '3:retry_limit' and :'s2' = '2:retry_limit' and :'s3' = '1:retry_limit',
  :'s1' || ' ' || :'s2' || ' ' || :'s3');
select t.ok('B5. пробный: генерация не потрачена (1 из 1), бюджет — 3 запуска', (t.me(:'ut') ->> 'ai_available')::int = 1 and t.budget() - :b1 = 3);

-- ======================================================================
-- 3. Сбой функции (итога нет): возврат квоты, но это неудача
-- ======================================================================
select t.register('BUDGETCODE03', 'KN-CAAAAA') as uc \gset
select t.note(:'uc') as c1 \gset
select t.ok('B6. запуск — started (затем функция «падает»)', t.start(:'uc', :'c1') = 'started');
update private.usage_ledger set reserved_at = reserved_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes' where op_key = :'c1';
update private.generation_starts set started_at = started_at - interval '11 minutes' where op_key = :'c1';
update public.notes set updated_at = updated_at - interval '11 minutes' where id = :'c1';
select t.ok('B6. через 11 минут: генерация вернулась (доступна 1), запуск засчитан как неудача',
  (t.me(:'uc') ->> 'ai_available')::int = 1 and private.failed_starts(:'uc', now() - interval '1 day') = 1);
select t.start(:'uc', :'c1') as b6 \gset
select t.ok('B6. повтор той же note: прежний незавершённый запуск помечен failed, новый — started', :'b6' = 'started'
  and (select count(*) filter (where outcome = 'failed') = 1 and count(*) filter (where outcome is null) = 1 from private.generation_starts where op_key = :'c1'), :'b6');
select t.finish(:'c1', true);
select t.ok('B6. успех: списано 1 раз, итог запуска ok', (select count(*) from private.usage_ledger where op_key = :'c1' and state = 'consumed') = 1
  and (select outcome from private.generation_starts where op_key = :'c1' order by id desc limit 1) = 'ok');
select t.ok('B7. двойного списания нет: повтор готовой note — ready', t.start(:'uc', :'c1') = 'ready'
  and (select count(*) from private.usage_ledger where op_key = :'c1') = 1);

-- ======================================================================
-- 4. Суточный предел всех запусков (если задан)
-- ======================================================================
update private.access_settings set max_starts_per_day = 2;
select t.register('BUDGETCODE04', 'KN-DAAAAA') as ud \gset
select private.admin_grant('KN-DAAAAA', null, 30, 10) ->> 'result' as r \gset
do $$ declare i int; n uuid; u uuid := (select id from auth.users where email = private.kn_email('KN-DAAAAA'));
begin for i in 1..2 loop n := t.note(u); if t.start(u, n) <> 'started' then raise exception 'start %', i; end if; perform t.finish(n, true); end loop; end $$;
select t.ok('B8. max_starts_per_day = 2: третий успешный запуск за сутки — daily_limit', t.start(:'ud', t.note(:'ud')) = 'daily_limit');
select t.day_passes(:'ud');
select t.ok('B8. через сутки — снова started', t.start(:'ud', t.note(:'ud')) = 'started');
update private.access_settings set max_starts_per_day = null;
update private.usage_ledger set state = 'released', finalized_at = now() where state = 'reserved';
update private.generation_starts set outcome = 'failed', finished_at = now() where outcome is null;

-- ======================================================================
-- 5. Владелец: без личных пределов, общий бюджет действует
-- ======================================================================
select t.register('BUDGETCODE05', 'KN-QAAAAA') as uo \gset
select private.admin_set_owner('KN-QAAAAA') ->> 'result' as r \gset
select t.fail_loop(:'uo', 6) as so \gset
select t.ok('B9. владелец: 6 неудач подряд — без retry_limit', :'so' = 'all_started', :'so');
update private.access_settings set max_starts_per_day = 1;
select t.ok('B9. владелец: суточный предел на него не действует', t.fail_loop(:'uo', 2) = 'all_started');
update private.access_settings set max_starts_per_day = null;
update private.ai_limits set max_total_starts = total_starts where id;
select t.ok('B10. владелец: общий бюджет исчерпан — ai_paused', t.start(:'uo', t.note(:'uo')) = 'ai_paused');
select (select count(*) from private.generation_starts where user_id = :'ud') as ud_starts \gset
select t.start(:'ud', t.note(:'ud')) as b10 \gset
select t.ok('B10. ученик: общий бюджет исчерпан — ai_paused, запуск не записан, генерация не тронута', :'b10' = 'ai_paused'
  and (select count(*) from private.generation_starts where user_id = :'ud') = :ud_starts, :'b10');
update private.ai_limits set max_total_starts = 1000 where id;

-- ======================================================================
-- 6. Отзыв платного во время пробного: остаток пробного без новых дней и без возврата генераций
-- ======================================================================
select t.register('BUDGETCODE06', 'KN-RAAAAA') as ur \gset
select (select ends_at from private.access_grants where user_id = :'ur' and kind = 'trial') as trial_end \gset
select t.note(:'ur') as r1 \gset
select t.start(:'ur', :'r1') as x \gset
select t.finish(:'r1', true);
select t.age(:'ur', interval '2 days');
select (select ends_at from private.access_grants where user_id = :'ur' and kind = 'trial') as trial_end \gset
select private.admin_grant('KN-RAAAAA', null, 30, 5) ->> 'result' as r \gset
select t.ok('B11. оплата во время пробного: paid', t.me(:'ur') ->> 'status' = 'paid');
select private.admin_revoke('KN-RAAAAA', 'тест') ->> 'result' as r \gset
select t.ok('B11. отзыв оплаты: снова trial до прежней даты (не начинается заново)', t.me(:'ur') ->> 'status' = 'trial'
  and (t.me(:'ur') ->> 'ends_at')::timestamptz = :'trial_end'::timestamptz);
select t.ok('B11. использованная пробная генерация не восстановлена (0 из 1)', (t.me(:'ur') ->> 'ai_available')::int = 0
  and t.start(:'ur', t.note(:'ur')) = 'limit_reached');
select private.admin_grant_trial('KN-RAAAAA') ->> 'result' as r \gset
select t.ok('B11. новый пробный тому же аккаунту не выдаётся', :'r' = 'trial_already_used');

-- ---------- итог ----------
select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok and info is not null then ' → ' || info else '' end from t.results order by n;
select 'ИТОГО: ' || count(*) filter (where ok) || ' PASS, ' || count(*) filter (where not ok) || ' FAIL' from t.results;
