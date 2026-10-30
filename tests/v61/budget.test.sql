-- v61.2: неудачные генерации — причины (user / tech), короткие паузы, общий автостоп, общий бюджет;
-- правило отзыва во время пробного периода. Только локальная копия базы (НЕ production). Запуск: run.sh (после миграции).
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
-- неудача с кодом, который записал бы analyze-pages (notes.error_code)
create function t.fail(p_note uuid, p_code text) returns void language sql as
  $$ update public.notes set status = 'failed', stage = 'failed', error_code = p_code where id = p_note $$;
-- новая note: запуск и (если started) неудача с кодом; возвращает ответ сервера
create function t.try_fail(p_uid uuid, p_code text) returns text language plpgsql as $$
declare n uuid := t.note(p_uid); r text;
begin r := t.start(p_uid, n); if r = 'started' then perform t.fail(n, p_code); end if; return r; end $$;
-- новая note: запуск и (если started) успех
create function t.try_ok(p_uid uuid) returns text language plpgsql as $$
declare n uuid := t.note(p_uid); r text;
begin r := t.start(p_uid, n); if r = 'started' then perform t.finish(n, true); end if; return r; end $$;
-- «прошло время» для журнала запусков пользователя (NULL — всех пользователей)
create function t.ago(p_uid uuid, p_by interval) returns void language plpgsql as
  $$ begin update private.generation_starts set started_at = started_at - p_by, finished_at = finished_at - p_by
           where p_uid is null or user_id = p_uid; end $$;
-- «прошло время» для выдач пользователя
create function t.age(p_uid uuid, p_by interval) returns void language plpgsql as
  $$ begin update private.access_grants set starts_at = starts_at - p_by, ends_at = ends_at - p_by where user_id = p_uid; end $$;
-- n технических неудач с паузой 16 минут между ними (как ученик, который ждёт после «ИИ сейчас не отвечает»)
create function t.tech_spaced(p_uid uuid, p_n int, p_code text default 'AI_TIMEOUT') returns text language plpgsql as $$
declare i int; r text;
begin
  for i in 1..p_n loop perform t.ago(p_uid, interval '16 minutes'); r := t.try_fail(p_uid, p_code); if r <> 'started' then return i || ':' || r; end if; end loop;
  return 'all_started';
end $$;
create function t.budget() returns int language sql as $$ select total_starts from private.ai_limits $$;
create function t.used(p_uid uuid) returns int language sql as $$ select (t.me(p_uid) ->> 'ai_used')::int $$;
create function t.avail(p_uid uuid) returns int language sql as $$ select (t.me(p_uid) ->> 'ai_available')::int $$;
-- между сценариями: прежние запуски уходят за пределы всех окон (суточного автостопа тоже)
create function t.reset() returns void language plpgsql as $$
begin perform t.ago(null, interval '3 days');
  update private.usage_ledger set state = 'released', finalized_at = now() where state = 'reserved'; end $$;

update private.ai_limits set beta_starts_at = '2026-10-18 21:00+00', beta_ends_at = '2026-10-23 21:00+00',
  max_total_starts = 1000, total_starts = 7, max_in_flight = 1, max_user_starts = 3 where id;
select t.ok('0. пределы по умолчанию: фото 3/сутки, пауза после 2 тех. за 15 мин, 4 тех./сутки, автостоп 3 за 30 мин (2+ польз.) или 6/сутки',
  (select (max_user_errors_per_day, tech_pause_after, tech_pause_minutes, max_tech_errors_per_day, breaker_errors, breaker_minutes, breaker_errors_per_day)
          = (3, 2, 15, 4, 3, 30, 6) from private.access_settings));

-- ======================================================================
-- T1. Платный месяц, лимит 1, три сбоя GigaChat — после восстановления генерация доступна
-- ======================================================================
select t.register('BUDGETCODE01', 'KN-PAAAAA') as u1 \gset
select private.admin_grant('KN-PAAAAA', null, 30, 1, 'тест') ->> 'result' as r \gset
select t.try_fail(:'u1', 'AI_ERROR') || ',' || t.try_fail(:'u1', 'AI_TIMEOUT') || ',' || t.try_fail(:'u1', 'AI_NETWORK') as t1 \gset
select t.ok('T1. два сбоя GigaChat подряд, третий — короткая пауза (cooldown), а не retry_limit до конца месяца', :'t1' = 'started,started,cooldown', :'t1');
select t.ago(:'u1', interval '16 minutes');
select t.ok('T1. через 16 минут — третий сбой (провайдер ещё лежит) — started', t.try_fail(:'u1', 'AI_ERROR') = 'started');
select t.ago(:'u1', interval '16 minutes');
select t.ok('T1. провайдер восстановился: генерация started и готова; списана 1 из 1', t.try_ok(:'u1') = 'started' and t.used(:'u1') = 1 and t.avail(:'u1') = 0);
select t.ok('T1. доступ всё время paid, срок не изменился', t.me(:'u1') ->> 'status' = 'paid'
  and (select count(*) from private.access_grants where user_id = :'u1' and kind = 'paid') = 1);
select t.reset();

-- ======================================================================
-- T2. Платный, лимит 3, три технические ошибки — оплаченные генерации остаются
-- ======================================================================
select t.register('BUDGETCODE02', 'KN-PBAAAA') as u2 \gset
select private.admin_grant('KN-PBAAAA', null, 30, 3) ->> 'result' as r \gset
select t.tech_spaced(:'u2', 1, 'SAVE_FAILED') || ',' || t.tech_spaced(:'u2', 1, 'INTERNAL') || ',' || t.tech_spaced(:'u2', 1, 'AI_RATE_LIMITED') as t2 \gset
select t.ok('T2. три технические ошибки разных видов — каждая started', :'t2' = 'all_started,all_started,all_started', :'t2');
select t.ok('T2. после них доступно 3 из 3', t.avail(:'u2') = 3 and t.used(:'u2') = 0);
select t.ago(:'u2', interval '16 minutes');
select t.try_ok(:'u2') || ',' || t.try_ok(:'u2') || ',' || t.try_ok(:'u2') || ',' || t.try_ok(:'u2') as t2b \gset
select t.ok('T2. все 3 оплаченные генерации получены, 4-я — limit_reached (лимит срока не нарушен)', :'t2b' = 'started,started,started,limit_reached', :'t2b');
select t.reset();

-- ======================================================================
-- T3. Пробный, три технических сбоя — единственная генерация не теряется
-- ======================================================================
select t.register('BUDGETCODE03', 'KN-TAAAAA') as u3 \gset
select t.ok('T3. три сбоя с паузами — все started (без retry_limit)', t.tech_spaced(:'u3', 3) = 'all_started');
select t.ok('T3. пробный идёт, генерация на месте (1 из 1)', t.me(:'u3') ->> 'status' = 'trial' and t.avail(:'u3') = 1);
select t.ago(:'u3', interval '16 minutes');
select t.ok('T3. после восстановления — пробная генерация получена', t.try_ok(:'u3') = 'started' and t.used(:'u3') = 1);
select t.reset();

-- ======================================================================
-- T4. Два сбоя провайдера подряд — нет блокировки на сутки
-- ======================================================================
select t.register('BUDGETCODE04', 'KN-PCAAAA') as u4 \gset
select private.admin_grant('KN-PCAAAA', null, 30, 10) ->> 'result' as r \gset
select t.try_fail(:'u4', 'AI_TIMEOUT') as x \gset
select t.try_fail(:'u4', 'AI_TIMEOUT') as x \gset
select t.note(:'u4') as n4 \gset
select public.start_text_generation_v2(:'u4', :'n4', 300, 600, 2) as r4 \gset
select t.ok('T4. сразу после 2 сбоев — cooldown с подсказкой 15 минут', :'r4'::jsonb ->> 'result' = 'cooldown' and (:'r4'::jsonb ->> 'retry_after_minutes')::int = 15, :'r4');
select t.ago(:'u4', interval '16 minutes');
select t.ok('T4. через 16 минут (не 24 часа) — started', t.try_ok(:'u4') = 'started');
select t.reset();

-- ======================================================================
-- T5. Многократные технические ошибки — короткая пауза и суточный предел; бюджет ограничен
-- ======================================================================
select t.register('BUDGETCODE05', 'KN-PDAAAA') as u5 \gset
select private.admin_grant('KN-PDAAAA', null, 30, 20) ->> 'result' as r \gset
select t.budget() as b5 \gset
select t.try_fail(:'u5', 'AI_ERROR') || ',' || t.try_fail(:'u5', 'AI_ERROR') || ',' || t.try_fail(:'u5', 'AI_ERROR') as t5 \gset
select t.ok('T5. 3-я попытка подряд — cooldown', :'t5' = 'started,started,cooldown', :'t5');
-- «бот»: 100 попыток, ждёт после каждой паузы
select t.tech_spaced(:'u5', 100, 'AI_ERROR') as t5b \gset
select t.ok('T5. за сутки не больше 4 технических неудач, дальше daily_limit', :'t5b' = '3:daily_limit', :'t5b');
select t.ok('T5. общий бюджет потрачен на 4 запуска (не 100)', t.budget() - :b5 = 4, (t.budget() - :b5)::text);
select t.ok('T5. генерации срока не тронуты (20 из 20)', t.avail(:'u5') = 20);
select t.ago(:'u5', interval '25 hours');
select t.ok('T5. через сутки — снова started (не до конца срока)', t.try_ok(:'u5') = 'started');
select t.reset();

-- ======================================================================
-- T6–T7. Массовый сбой GigaChat — общий автостоп; восстановление
-- ======================================================================
select t.register('BUDGETCODE06', 'KN-MAAAAA') as ma \gset
select t.register('BUDGETCODE07', 'KN-MBAAAA') as mb \gset
select t.register('BUDGETCODE08', 'KN-MCAAAA') as mc \gset
select t.register('BUDGETCODE09', 'KN-MDAAAA') as md \gset
select private.admin_set_owner('KN-MDAAAA') ->> 'result' as r \gset
select t.try_fail(:'ma', 'AI_ERROR') || ',' || t.try_fail(:'ma', 'AI_ERROR') as x \gset
select t.ok('T6. сбои у одного ученика — общий автостоп не срабатывает (другим можно)', not private.ai_breaker());
select t.try_fail(:'mb', 'AI_ERROR') as x \gset
select t.ok('T6. 3 тех. неудачи у 2 пользователей за 30 минут — автостоп', private.ai_breaker());
select t.budget() as b6 \gset
select t.start(:'mc', t.note(:'mc')) || ',' || t.start(:'md', t.note(:'md')) as t6 \gset
select t.ok('T6. новый ученик и владелец — ai_unavailable', :'t6' = 'ai_unavailable,ai_unavailable', :'t6');
select t.ok('T6. при автостопе запуски не записаны, бюджет не тронут, генерация на месте', t.budget() = :b6 and t.avail(:'mc') = 1
  and not exists (select 1 from private.generation_starts where user_id in (:'mc', :'md')));
select t.ago(null, interval '31 minutes');
select t.ok('T7. через 31 минуту автостоп снят сам', not private.ai_breaker());
select t.ok('T7. генерации снова идут', t.try_ok(:'mc') = 'started' and t.try_ok(:'md') = 'started');
-- длинный сбой: суточный предел автостопа (6 тех. неудач у всех за 24 часа)
select t.ago(null, interval '31 minutes');
select t.try_fail(:'ma', 'AI_ERROR') || ',' || t.try_fail(:'mb', 'AI_ERROR') || ',' || t.try_fail(:'md', 'AI_ERROR') as x \gset
select t.ok('T6. 6 тех. неудач за сутки (3 + 3) — автостоп', private.ai_breaker());
select t.ago(null, interval '31 minutes');
select t.start(:'md', t.note(:'md')) as t6d \gset
select t.ok('T6. суточный автостоп не снимается через 31 минуту (сбой длинный)', private.ai_breaker() and :'t6d' = 'ai_unavailable', :'t6d');
select t.ago(null, interval '24 hours');
select t.try_ok(:'md') as t7d \gset
select t.ok('T7. через сутки снят, генерация started', not private.ai_breaker() and :'t7d' = 'started', :'t7d');
select t.reset();

-- ======================================================================
-- T8. Ошибки по вине фото — свой предел; паузы технических ошибок их не касаются
-- ======================================================================
select t.register('BUDGETCODE10', 'KN-UAAAAA') as u8 \gset
select private.admin_grant('KN-UAAAAA', null, 30, 5) ->> 'result' as r \gset
select t.try_fail(:'u8', 'UNREADABLE_PAGES') || ',' || t.try_fail(:'u8', 'UNREADABLE_PAGES') || ',' || t.try_fail(:'u8', 'UNREADABLE_PAGES')
       || ',' || t.try_fail(:'u8', 'UNREADABLE_PAGES') as t8 \gset
select t.ok('T8. нечитаемые фото: 3 попытки подряд без паузы, 4-я — retry_limit', :'t8' = 'started,started,started,retry_limit', :'t8');
select t.ok('T8. генерации срока не потрачены (5 из 5), доступ paid', t.avail(:'u8') = 5 and t.me(:'u8') ->> 'status' = 'paid');
select t.ok('T8. ошибки фото не включают общий автостоп', not private.ai_breaker());
select t.ago(:'u8', interval '25 hours');
select t.ok('T8. на следующий день — started', t.try_ok(:'u8') = 'started');
select t.ok('T8. причина записана сервером в журнал (error_code)', (select count(*) from private.generation_starts where user_id = :'u8' and error_code = 'UNREADABLE_PAGES') = 3);
select t.reset();

-- ======================================================================
-- T9. Параллельные запросы (последовательная имитация: первые ещё идут)
-- ======================================================================
update private.ai_limits set max_in_flight = 5 where id;
select t.register('BUDGETCODE11', 'KN-PEAAAA') as u9 \gset
select private.admin_grant('KN-PEAAAA', null, 30, 10) ->> 'result' as r \gset
select t.note(:'u9') as a \gset
select t.note(:'u9') as b \gset
select t.note(:'u9') as c \gset
select t.start(:'u9', :'a') || ',' || t.start(:'u9', :'b') || ',' || t.start(:'u9', :'c') as t9 \gset
select t.ok('T9. 3 запуска без итога: начаты 2, третий — cooldown (идущие считаются возможными неудачами)', :'t9' = 'started,started,cooldown', :'t9');
select t.ok('T9. та же note повторно, пока идёт, — already_processing (второй платной генерации нет)', t.start(:'u9', :'a') = 'already_processing');
select t.finish(:'a', true);
select t.finish(:'b', true);
select t.ok('T9. оба успешны: списано ровно 2', t.used(:'u9') = 2);
select t.ok('T9. после завершения — снова можно', t.start(:'u9', :'c') = 'started');
select t.finish(:'c', true);
update private.ai_limits set max_in_flight = 1 where id;
select t.reset();

-- ======================================================================
-- T10. Владелец: успехи без лимита, но неудачи ограничены — бюджет не уходит бесконтрольно
-- ======================================================================
select t.register('BUDGETCODE12', 'KN-QAAAAA') as uo \gset
select private.admin_set_owner('KN-QAAAAA') ->> 'result' as r \gset
select t.ok('T10. владелец: 6 успешных генераций подряд (без личного лимита)',
  t.try_ok(:'uo') || t.try_ok(:'uo') || t.try_ok(:'uo') || t.try_ok(:'uo') || t.try_ok(:'uo') || t.try_ok(:'uo') = repeat('started', 6));
update private.access_settings set max_starts_per_day = 1;
select t.ok('T10. суточный предел всех запусков на владельца не действует', t.try_ok(:'uo') = 'started');
update private.access_settings set max_starts_per_day = null;
select t.budget() as b10 \gset
select t.try_fail(:'uo', 'AI_ERROR') || ',' || t.try_fail(:'uo', 'AI_ERROR') || ',' || t.try_fail(:'uo', 'AI_ERROR') as t10 \gset
select t.ok('T10. владелец: 3-я неудача подряд — cooldown', :'t10' = 'started,started,cooldown', :'t10');
select t.ok('T10. владелец: цикл повторов — не больше 4 неудач за сутки', t.tech_spaced(:'uo', 100) = '3:daily_limit' and t.budget() - :b10 = 4,
  (t.budget() - :b10)::text);
select t.ago(:'uo', interval '25 hours');
select t.try_fail(:'uo', 'UNREADABLE_PAGES') || t.try_fail(:'uo', 'UNREADABLE_PAGES') || t.try_fail(:'uo', 'UNREADABLE_PAGES') || ',' || t.try_fail(:'uo', 'UNREADABLE_PAGES') as t10b \gset
select t.ok('T10. владелец: 4-я ошибка фото — retry_limit', :'t10b' = 'startedstartedstarted,retry_limit', :'t10b');
select t.reset();

-- ======================================================================
-- T11. Общий бюджет исчерпан — новые генерации не запускаются ни у кого
-- ======================================================================
select t.register('BUDGETCODE13', 'KN-PFAAAA') as u11 \gset
update private.ai_limits set max_total_starts = total_starts where id;
select (select count(*) from private.generation_starts) as gs11 \gset
select t.ok('T11. бюджет исчерпан: ученик, владелец — ai_paused', t.start(:'u11', t.note(:'u11')) = 'ai_paused' and t.start(:'uo', t.note(:'uo')) = 'ai_paused');
select t.ok('T11. запуски не записаны, генерация ученика на месте, бюджет 40 не увеличен автоматически',
  (select count(*) from private.generation_starts) = :gs11 and t.avail(:'u11') = 1 and (select max_total_starts = total_starts from private.ai_limits));
update private.ai_limits set max_total_starts = 1000 where id;
select t.reset();

-- ======================================================================
-- T12. Старые F&F и служебные аккаунты (без выдач): как раньше; автостоп и журнал — и для них
-- ======================================================================
do $$ declare v uuid; begin
  insert into auth.users (email, raw_app_meta_data) values (private.kn_email('KN-FFAAAA'), '{}') returning id into v;
  -- участник F&F, зарегистрированный ДО v61 (триггера пробного периода тогда не было)
  update private.access_settings set trial_on_register = false;
  insert into private.user_entitlements (user_id, resource, plan, quota, source) values (v, 'text_generation', 'beta', 1, 'beta_invite');
  update private.access_settings set trial_on_register = true;
  insert into auth.users (is_anonymous) values (true) returning id into v;
  insert into private.user_entitlements (user_id, resource, plan, quota, source) values (v, 'text_generation', 'beta', 100, 'manual');
  perform set_config('t.anon', v::text, false);
end $$;
select id as uf from auth.users where email = private.kn_email('KN-FFAAAA') \gset
select current_setting('t.anon') as ua \gset
select t.ok('T12. F&F: выдач нет, legacy/expired, генерация — access_expired (как в v59)',
  not exists (select 1 from private.access_grants where user_id = :'uf') and t.me(:'uf') ->> 'kind' = 'legacy' and t.start(:'uf', t.note(:'uf')) = 'access_expired');
select t.try_ok(:'ua') as t12 \gset
select t.ok('T12. служебный аккаунт: started прежней проверкой, успех списан, запуск записан в журнал', :'t12' = 'started'
  and (select outcome from private.generation_starts where user_id = :'ua') = 'ok'
  and (select count(*) from private.usage_ledger where user_id = :'ua' and state = 'consumed') = 1, :'t12');
select t.try_fail(:'ua', 'AI_ERROR') || t.try_fail(:'ua', 'AI_ERROR') || t.try_fail(:'ua', 'AI_ERROR') as x \gset
select t.try_fail(:'u11', 'AI_ERROR') as x \gset
select t.ok('T12. сбои служебного аккаунта учитываются в общем автостопе', private.ai_breaker());
select t.budget() as b12 \gset
select t.note(:'ua') as n12 \gset
select t.ok('T12. при автостопе служебный аккаунт тоже получает ai_unavailable', t.start(:'ua', :'n12') = 'ai_unavailable');
select t.ok('T12. отменённый запуск не оставил следов: резерва, запуска в журнале и траты бюджета нет; note не захвачена',
  t.budget() = :b12 and not exists (select 1 from private.usage_ledger where op_key = :'n12')
  and not exists (select 1 from private.generation_starts where op_key = :'n12')
  and (select stage from public.notes where id = :'n12') = 'uploading');
select t.ok('T12. F&F при автостопе получает прежний ответ v59 — access_expired', t.start(:'uf', t.note(:'uf')) = 'access_expired');
select t.reset();

-- ======================================================================
-- T13. Общий бюджет: после обращения к провайдеру неудача тратит запуск, до обращения — нет
-- ======================================================================
select t.register('BUDGETCODE14', 'KN-PGAAAA') as u13 \gset
select private.admin_grant('KN-PGAAAA', null, 30, 10) ->> 'result' as r \gset
select t.budget() as b13 \gset
select t.tech_spaced(:'u13', 1, 'AI_TIMEOUT') as x \gset
select t.ok('T13. сбой GigaChat (после обращения) — запуск бюджета потрачен (+1)', t.budget() - :b13 = 1);
select t.tech_spaced(:'u13', 1, 'SAVE_FAILED') as x \gset
select t.ok('T13. ошибка сохранения (ответ провайдера уже получен) — потрачен (+1)', t.budget() - :b13 = 2);
select t.tech_spaced(:'u13', 1, 'STORAGE_READ_FAILED') as x \gset
select t.ok('T13. фото не прочитаны из хранилища (до обращения) — запуск возвращён', t.budget() - :b13 = 2);
select t.ago(:'u13', interval '25 hours');
select t.try_fail(:'u13', 'IMAGE_TOO_LARGE') as x \gset
select t.ok('T13. файл слишком большой (до обращения) — запуск возвращён', t.budget() - :b13 = 2);
select t.note(:'u13') as n13 \gset
select t.start(:'u13', :'n13') as x \gset
update public.notes set status = 'failed', stage = 'failed', error_code = 'STORAGE_READ_FAILED' where id = :'n13';
update public.notes set status = 'processing', stage = 'uploading' where id = :'n13';
update public.notes set status = 'failed', stage = 'failed', error_code = 'STORAGE_READ_FAILED' where id = :'n13';
select t.ok('T13. повторная пометка той же неудачи не возвращает бюджет второй раз', t.budget() - :b13 = 2);
select t.ok('T13. успех тратит ровно 1', t.try_ok(:'u13') = 'started' and t.budget() - :b13 = 3);
select t.reset();

-- ======================================================================
-- T14. Неизвестная ошибка и прерванная функция — квота не теряется, повторы ограничены
-- ======================================================================
select t.register('BUDGETCODE15', 'KN-PHAAAA') as u14 \gset
select private.admin_grant('KN-PHAAAA', null, 30, 1) ->> 'result' as r \gset
select t.budget() as b14 \gset
select t.try_fail(:'u14', 'SOMETHING_NEW') as t14 \gset
select t.ok('T14. неизвестный код ошибки — запуск, затем как техническая', :'t14' = 'started'
  and (select private.failure_kind(error_code) from private.generation_starts where user_id = :'u14') = 'tech', :'t14');
select t.note(:'u14') as n14 \gset
select t.ok('T14. затем функция «упала» (итога нет)', t.start(:'u14', :'n14') = 'started');
update private.usage_ledger set reserved_at = reserved_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes' where op_key = :'n14';
update private.generation_starts set started_at = started_at - interval '11 minutes' where op_key = :'n14';
update public.notes set updated_at = updated_at - interval '11 minutes' where id = :'n14';
select t.ok('T14. через 11 минут: генерация вернулась (1 из 1), бюджет учёл оба запуска', t.avail(:'u14') = 1 and t.budget() - :b14 = 2);
select t.ok('T14. сразу снова — cooldown (2 тех. неудачи за 15 минут), не retry_limit', t.start(:'u14', t.note(:'u14')) = 'cooldown');
select t.ago(:'u14', interval '16 minutes');
select t.start(:'u14', :'n14') as t14b \gset
select t.finish(:'n14', true);
select t.ok('T14. повтор той же note после паузы — started; затем успех: списано 1, двойного списания нет', :'t14b' = 'started'
  and t.used(:'u14') = 1 and (select count(*) from private.usage_ledger where op_key = :'n14' and state = 'consumed') = 1, :'t14b');
select t.ok('T14. повтор готовой note — ready, без нового списания', t.start(:'u14', :'n14') = 'ready' and t.used(:'u14') = 1);
select t.reset();

-- ======================================================================
-- T15. Срок закончился во время сбоя — автоматически не продлевается
-- ======================================================================
select t.register('BUDGETCODE16', 'KN-PJAAAA') as u15 \gset
select private.admin_grant('KN-PJAAAA', null, 30, 3) ->> 'result' as r \gset
select t.try_fail(:'u15', 'AI_ERROR') as x \gset
select t.age(:'u15', interval '31 days');
select t.ok('T15. после окончания срока: expired, генерация — access_expired, новых выдач нет', t.me(:'u15') ->> 'status' = 'expired'
  and t.start(:'u15', t.note(:'u15')) = 'access_expired' and (select count(*) from private.access_grants where user_id = :'u15' and kind = 'paid') = 1);
select t.reset();

-- ======================================================================
-- B8. Суточный предел всех запусков (если задан) — как в v61.1
-- ======================================================================
update private.access_settings set max_starts_per_day = 2;
select t.register('BUDGETCODE17', 'KN-DAAAAA') as ud \gset
select private.admin_grant('KN-DAAAAA', null, 30, 10) ->> 'result' as r \gset
select t.ok('B8. max_starts_per_day = 2: третий успешный запуск за сутки — daily_limit', t.try_ok(:'ud') || t.try_ok(:'ud') || t.try_ok(:'ud') = 'startedstarteddaily_limit');
select t.ago(:'ud', interval '25 hours');
select t.ok('B8. через сутки — снова started', t.try_ok(:'ud') = 'started');
update private.access_settings set max_starts_per_day = null;
select t.reset();

-- ======================================================================
-- 6. Отзыв платного во время пробного: остаток пробного без новых дней и без возврата генераций
-- ======================================================================
select t.register('BUDGETCODE18', 'KN-RAAAAA') as ur \gset
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
