-- v66.6: владелец не попадает под суточный предел технических ошибок и общий автостоп ИИ; остальные пределы прежние.
-- Только локальная копия базы (НЕ production). Запуск: tests/v66r/owner-tech-limit.test.sh.
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
-- v66.6: настройки как в production 08.11.2026
update private.access_settings set max_user_errors_per_day = 3, max_tech_errors_per_day = 4, tech_pause_after = 2, tech_pause_minutes = 15,
  breaker_errors = 3, breaker_minutes = 30, breaker_errors_per_day = 6, max_starts_per_day = null,
  trial_ai_quota = 100;  -- только в тестовой копии: чтобы квота пробного не мешала проверке пределов ошибок
update private.ai_limits set max_total_starts = 1000, total_starts = 0, max_in_flight = 1, max_pages = 4, ai_enabled = true where id;
create function t.mk(p_n int) returns uuid language sql as $$ select t.register('V666CODE' || lpad(p_n::text, 4, '0'), 'KN-V' || chr(64 + p_n) || 'AAAA') $$;
create function t.kn(p_n int) returns text language sql as $$ select 'KN-V' || chr(64 + p_n) || 'AAAA' $$;

-- владелец, ученик на пробном, ученик Premium, ученик Premium с отозванной выдачей владельца
select t.mk(1) as uo \gset
select private.admin_set_owner(t.kn(1)) ->> 'result' as r1 \gset
select t.mk(2) as ut \gset
select t.mk(3) as up \gset
select private.admin_grant(t.kn(3), 'premium') ->> 'result' as r3 \gset
select t.mk(4) as ux \gset
select private.admin_set_owner(t.kn(4)) ->> 'result' as r4a \gset
select private.admin_revoke(t.kn(4), 'тест', 'owner') ->> 'result' as r4b \gset
select t.ok('S0. роли: владелец, пробный, Premium, бывший владелец', :'r1' is not null and :'r3' is not null,
  (select string_agg(user_id::text || ':' || kind || ':' || (revoked_at is null)::text, ' ') from private.access_grants));

-- O1. владелец: 10 технических ошибок за сутки с паузами 16 минут — каждая следующая запускается (раньше 5-я — daily_limit)
select t.tech_spaced(:'uo', 10) as o1 \gset
select t.ok('O1. владелец: 10 тех. ошибок за сутки — без суточного предела', :'o1' = 'all_started', :'o1');
select t.ok('O1. записи ошибок владельца сохраняются (10 за 24 ч)',
  private.failed_starts(:'uo', now() - interval '24 hours', 'tech') = 10, private.failed_starts(:'uo', now() - interval '24 hours', 'tech')::text);
-- O2. общий автостоп ошибками владельца не включается; ученик в это время запускается
select t.ok('O2. 10 ошибок владельца не включают общий автостоп', private.ai_breaker() = false);
select t.ok('O2. ученик (пробный) запускается сразу после ошибок владельца', t.try_ok(:'ut') = 'started');
-- O3. пауза после 2 ошибок подряд у владельца сохраняется
select t.ago(:'uo', interval '16 minutes');
select t.try_fail(:'uo', 'AI_TIMEOUT') || ',' || t.try_fail(:'uo', 'AI_TIMEOUT') || ',' || t.try_fail(:'uo', 'AI_TIMEOUT') as o3 \gset
select t.ok('O3. владелец: 3-я ошибка подряд — cooldown (защита от бесконечных повторов)', :'o3' = 'started,started,cooldown', :'o3');
-- O4. предел ошибок фото (retry_limit) у владельца прежний
select t.reset();
select t.try_fail(:'uo', 'UNREADABLE_PAGES') || t.try_fail(:'uo', 'UNREADABLE_PAGES') || t.try_fail(:'uo', 'UNREADABLE_PAGES') || ',' || t.try_fail(:'uo', 'UNREADABLE_PAGES') as o4 \gset
select t.ok('O4. владелец: 4-я ошибка фото — retry_limit (без изменений)', :'o4' = 'startedstartedstarted,retry_limit', :'o4');
-- O5. параллельный запуск владельца при занятом ИИ — ai_busy (без изменений)
select t.reset();
select t.note(:'ut') as nb \gset
select t.start(:'ut', :'nb') as o5a \gset
select t.ok('O5. ученик занял ИИ', :'o5a' = 'started', :'o5a');
select t.try_ok(:'uo') as o5b \gset
select t.ok('O5. владелец при занятом ИИ — ai_busy', :'o5b' = 'ai_busy', :'o5b');
select t.finish(:'nb', true);
select t.reset();

-- S1–S3. ученики: суточный предел 4 тех. ошибки прежний (5-я — daily_limit)
select t.tech_spaced(:'ut', 10) as s1 \gset
select t.ok('S1. пробный: 5-я тех. ошибка за сутки — daily_limit', :'s1' = '5:daily_limit', :'s1');
select t.reset();
select t.tech_spaced(:'up', 10) as s2 \gset
select t.ok('S2. Premium: 5-я тех. ошибка за сутки — daily_limit', :'s2' = '5:daily_limit', :'s2');
select t.reset();
select t.tech_spaced(:'ux', 10) as s3 \gset
select t.ok('S3. бывший владелец (выдача отозвана): исключения нет', :'s3' = '5:daily_limit',
  (select kind from private.active_grant(:'ux')) || '/' || :'s3');
select t.reset();
-- S4. ученики: предел ошибок фото и пауза прежние
select t.try_fail(:'ut', 'UNREADABLE_PAGES') || t.try_fail(:'ut', 'UNREADABLE_PAGES') || t.try_fail(:'ut', 'UNREADABLE_PAGES') || ',' || t.try_fail(:'ut', 'UNREADABLE_PAGES') as s4 \gset
select t.ok('S4. пробный: 4-я ошибка фото — retry_limit', :'s4' = 'startedstartedstarted,retry_limit', :'s4');
select t.reset();
select t.try_fail(:'up', 'AI_TIMEOUT') || ',' || t.try_fail(:'up', 'AI_TIMEOUT') || ',' || t.try_fail(:'up', 'AI_TIMEOUT') as s4b \gset
select t.ok('S4. Premium: 3-я ошибка подряд — cooldown', :'s4b' = 'started,started,cooldown', :'s4b');
select t.reset();
-- S5. фото: 5 страниц ученику — too_many_pages (max_pages = 4)
select t.note(:'ut') as n5 \gset
select t.ok('S5. ученик: 5 фото — too_many_pages', t.start(:'ut', :'n5', 5) = 'too_many_pages');
select t.reset();
-- S6. общий автостоп для учеников работает: 6 тех. ошибок учеников за сутки — ИИ недоступен всем, в том числе владельцу
select t.tech_spaced(:'ut', 3) as x1 \gset
select t.tech_spaced(:'up', 3) as x2 \gset
select t.ok('S6. 6 ошибок учеников за сутки — общий автостоп включён', private.ai_breaker() = true, :'x1' || '/' || :'x2');
select t.ok('S6. при автостопе ученик получает ai_unavailable', t.try_ok(:'ux') = 'ai_unavailable');
select t.ok('S6. при автостопе владелец тоже получает ai_unavailable', t.try_ok(:'uo') = 'ai_unavailable');
select t.reset();
-- S7. 2 ошибки ученика + ошибки владельца за 30 минут: окно автостопа не включается (владелец не считается)
select t.try_fail(:'ut', 'AI_TIMEOUT') as y1 \gset
select t.try_fail(:'uo', 'AI_TIMEOUT') as y2 \gset
select t.try_fail(:'uo', 'AI_TIMEOUT') as y3 \gset
select t.ago(:'uo', interval '16 minutes');
select t.try_fail(:'up', 'AI_TIMEOUT') as y4 \gset
select t.ok('S7. 2 ошибки учеников + 2 владельца за 30 мин — автостоп не включён', private.ai_breaker() = false);
select t.try_fail(:'ux', 'AI_TIMEOUT') as y5 \gset
select t.ok('S7. 3 ошибки разных учеников за 30 мин — автостоп включён (как прежде)', private.ai_breaker() = true);
select t.reset();

-- P. подделка признака владельца из API невозможна
create function t.as_user(p_uid uuid, p_sql text) returns text language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', p_uid::text, true); set local role authenticated; execute p_sql; reset role; return 'allowed';
exception when others then reset role; return sqlstate; end $$;
select t.ok('P1. ученик не может создать выдачу владельца', t.as_user(:'ut',
  format('insert into private.access_grants (user_id, kind, starts_at, granted_by) values (%L, ''owner'', now(), ''x'')', :'ut')) <> 'allowed');
select t.ok('P2. ученик не может вызвать admin_set_owner', t.as_user(:'ut', format('select private.admin_set_owner(%L)', t.kn(2))) <> 'allowed');
select t.ok('P3. ученик не может вызвать запуск генерации напрямую (только service_role)',
  t.as_user(:'ut', format('select public.start_text_generation_v2(%L, gen_random_uuid())', :'ut')) <> 'allowed');
select t.ok('P4. ученик не может изменить свою выдачу', t.as_user(:'ut',
  format('update private.access_grants set kind = ''owner'' where user_id = %L', :'ut')) <> 'allowed');
select t.ok('P5. у ученика по-прежнему нет выдачи владельца', (select kind from private.active_grant(:'ut')) = 'trial');

select '' ;
select case when ok then 'PASS ' else 'FAIL ' end || name || coalesce(' [' || info || ']', '') from t.results order by n;
select (select count(*) from t.results where ok) || ' / ' || (select count(*) from t.results) || ' проверок';
