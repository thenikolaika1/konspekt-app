-- v61.3: панель владельца — постоянный пароль, сессия, права, подписки, приглашения, данные.
-- Только локальная копия базы (НЕ production). Запуск: run.sh (после миграций v61 и панели).
\set QUIET on
\pset tuples_only on
\pset format unaligned
set client_min_messages = warning;

create schema t;
create table t.results (n serial, name text, ok boolean, info text);
create function t.ok(p_name text, p_ok boolean, p_info text default null) returns void language sql as
  $$ insert into t.results (name, ok, info) values (p_name, coalesce(p_ok, false), p_info) $$;
create table t.secrets (what text, value text);   -- что не должно появиться ни в одном ответе и журнале
-- регистрация по коду — как Edge Function register-invite; ключ → пароль входа 'Kn-2.' || ключ (bcrypt)
create function t.register_with(p_code text, p_kn text, p_key text default 'AAAAABBBBBCCCCCDDDDD') returns uuid language plpgsql as $$
declare r jsonb; v uuid;
begin
  r := public.register_invite_begin(p_code, p_kn, repeat('c', 64));
  if r ->> 'result' <> 'reserved' and r ->> 'result' <> 'resume' then return null; end if;
  insert into auth.users (email, encrypted_password, raw_app_meta_data)
  values (private.kn_email(p_kn), extensions.crypt('Kn-2.' || p_key, extensions.gen_salt('bf', 4)), jsonb_build_object('kn_reservation', r ->> 'reservation'))
  returning id into v;
  r := public.register_invite_finish(p_code, (r ->> 'reservation')::uuid, v);
  if r ->> 'result' <> 'done' then raise exception 'finish: %', r; end if;
  return v;
end $$;
create function t.register(p_code text, p_kn text, p_key text default 'AAAAABBBBBCCCCCDDDDD') returns uuid language plpgsql as $$
begin
  insert into private.beta_invites (code_hash, quota, expires_at) values (private.invite_code_hash(p_code), 1, now() + interval '7 days');
  return t.register_with(p_code, p_kn, p_key);
end $$;
-- вход Supabase Auth: строка сессии входа; claims — как в JWT
create function t.login(p_uid uuid) returns uuid language sql as
  $$ insert into auth.sessions (user_id) values (p_uid) returning id $$;
create table t.ctx (uid uuid, sid uuid, anon boolean default false);
insert into t.ctx values (null, null);
create function t.as_user(p_uid uuid, p_sid uuid, p_anon boolean default false) returns void language sql as
  $$ update t.ctx set uid = p_uid, sid = p_sid, anon = p_anon $$;
-- вызов как браузер: роль authenticated, claims текущего пользователя (t.ctx)
create function t.api(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb; c t.ctx;
begin
  select * into c from t.ctx;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', c.uid, 'session_id', c.sid, 'role', 'authenticated',
                                                              'is_anonymous', c.anon, 'aal', 'aal1')::text, true);
  set local role authenticated;
  execute p_sql into r;
  reset role;
  return r;
exception when others then
  reset role;
  return jsonb_build_object('sqlerror', sqlstate, 'message', sqlerrm);
end $$;
create function t.q(p text) returns text language sql immutable as $$ select quote_literal(p) $$;
create function t.age_sessions(p_uid uuid, p_by interval) returns void language sql as
  $$ update private.owner_panel_sessions set created_at = created_at - p_by, last_used_at = last_used_at - p_by, expires_at = expires_at - p_by where user_id = p_uid $$;

update private.ai_limits set beta_starts_at = '2026-10-18 21:00+00', beta_ends_at = '2026-10-23 21:00+00',
  max_total_starts = 40, total_starts = 7, max_in_flight = 1, max_user_starts = 3 where id;
create table t.limits_before as select * from private.ai_limits;

-- ===== участники =====
select t.register('OWNERCODE001', 'KN-WAAAAA', 'KEYABCDEFGHJKMNPQRST') as uo \gset
select private.admin_set_owner('KN-WAAAAA', 'тест') ->> 'result' as r \gset
select t.register('STUDCODE0001', 'KN-SAAAAA') as us \gset
select t.register('STUDCODE0002', 'KN-SBAAAA') as us2 \gset
select t.register('STUDCODE0003', 'KN-SCAAAA') as us3 \gset
do $$ declare v uuid; begin
  insert into auth.users (email) values (private.kn_email('KN-FFAAAA')) returning id into v;
  update private.access_settings set trial_on_register = false;
  insert into private.user_entitlements (user_id, resource, plan, quota, source) values (v, 'text_generation', 'beta', 1, 'beta_invite');
  update private.access_settings set trial_on_register = true;
  insert into auth.users (is_anonymous) values (true);
end $$;
select id as uf from auth.users where email = private.kn_email('KN-FFAAAA') \gset
select id as ug from auth.users where is_anonymous limit 1 \gset
select t.login(:'uo') as so \gset
select t.login(:'us') as ss \gset
select t.login(:'uf') as sf \gset
select t.login(:'ug') as sg \gset

-- ======================================================================
-- Авторизация
-- ======================================================================
-- гость, ученик, F&F: кнопки нет (state.owner=false) и ни одной функции панели
select t.as_user(:'ug', :'sg', true);
select t.api('select public.owner_panel_state()') as g1 \gset
select t.api('select public.owner_unlock(''x'')') as g2 \gset
select t.ok('A1. гость: owner_panel_state → owner=false; owner_unlock → FORBIDDEN', (:'g1'::jsonb ->> 'owner')::boolean = false
  and :'g2'::jsonb ->> 'error' = 'FORBIDDEN', :'g1' || :'g2');
select t.as_user(:'us', :'ss');
select t.ok('A2. ученик: owner=false, без лишних полей', t.api('select public.owner_panel_state()') = '{"owner": false}'::jsonb);
create table t.student_calls as select f, t.api(f) r from unnest(array[
  'select public.owner_unlock(''AAAAABBBBBCCCCCDDDDD'')', 'select public.owner_panel_setup(''X'', ''Y'')',
  'select public.owner_overview(''x'')', 'select public.owner_students(''x'')', 'select public.owner_student(''x'', ''KN-SBAAAA'')',
  'select public.owner_preview(''x'', ''KN-SBAAAA'', ''grant'', 30, 20)',
  'select public.owner_grant(''x'', gen_random_uuid(), ''KN-SAAAAA'', 30, 20)',
  'select public.owner_extend(''x'', gen_random_uuid(), ''KN-SAAAAA'', 30, 20)',
  'select public.owner_revoke(''x'', gen_random_uuid(), ''KN-SAAAAA'')',
  'select public.owner_invite_create(''x'', gen_random_uuid(), ''я'', 7)', 'select public.owner_invites(''x'')',
  'select public.owner_invite_revoke(''x'', gen_random_uuid(), gen_random_uuid())', 'select public.owner_ai(''x'')',
  'select public.owner_history(''x'')', 'select public.owner_lock_all(''x'')', 'select public.owner_change_password(''x'', ''a'', ''b'')']) f;
select t.ok('A2. ученик: все 16 функций панели → FORBIDDEN', (select bool_and(r ->> 'error' = 'FORBIDDEN') from t.student_calls),
  (select string_agg(r::text, ' ') from t.student_calls where r ->> 'error' is distinct from 'FORBIDDEN'));
select t.ok('A2. ученик: прямой доступ к закрытым таблицам и admin_* — запрещён (права PostgreSQL)',
  t.api('select to_jsonb(count(*)) from private.owner_panel_secrets') ->> 'sqlerror' = '42501'
  and t.api('select private.admin_grant(''KN-SAAAAA'', null, 30, 20)') ->> 'sqlerror' = '42501'
  and t.api('select private.admin_panel_setup(''KN-WAAAAA'')') ->> 'sqlerror' = '42501'
  and t.api('select to_jsonb(count(*)) from private.access_log') ->> 'sqlerror' = '42501');
select t.ok('A2. ученик не получил выдач', not exists (select 1 from private.access_grants where user_id = :'us' and kind = 'paid'));
select t.as_user(:'uf', :'sf');
select t.ok('A3. F&F: owner=false; owner_unlock и owner_overview → FORBIDDEN', (t.api('select public.owner_panel_state()') ->> 'owner')::boolean = false
  and t.api('select public.owner_unlock(''AAAAABBBBBCCCCCDDDDD'')') ->> 'error' = 'FORBIDDEN'
  and t.api('select public.owner_overview(null)') ->> 'error' = 'FORBIDDEN');
-- гость с claims чужого (владельца) uid, но is_anonymous — отказ
select t.as_user(:'uo', :'so', true);
select t.ok('A3. JWT с is_anonymous=true даже для uid владельца → FORBIDDEN', t.api('select public.owner_unlock(''x'')') ->> 'error' = 'FORBIDDEN');

-- владелец до установки пароля
select t.as_user(:'uo', :'so');
select t.api('select public.owner_panel_state()') as st0 \gset
select t.ok('A4. владелец до пароля: owner=true, password_set=false, setup_pending=false', :'st0'::jsonb ->> 'owner' = 'true'
  and :'st0'::jsonb ->> 'password_set' = 'false' and :'st0'::jsonb ->> 'setup_pending' = 'false', :'st0');
select t.ok('A4. владелец без пароля и сессии: функции панели → PANEL_LOCKED', t.api('select public.owner_overview(null)') ->> 'error' = 'PANEL_LOCKED'
  and t.api('select public.owner_overview(''' || repeat('a', 64) || ''')') ->> 'error' = 'PANEL_LOCKED'
  and t.api('select public.owner_grant(null, gen_random_uuid(), ''KN-SAAAAA'', 30, 20)') ->> 'error' = 'PANEL_LOCKED');
select t.ok('A4. вход без установленного пароля → NOT_SET; установка без кода → NO_SETUP_CODE',
  t.api('select public.owner_unlock(''AAAAABBBBBCCCCCDDDDD'')') ->> 'error' = 'NOT_SET'
  and t.api('select public.owner_panel_setup(''ABCD-EFGH-JKMN'', ''QQQQQWWWWWEEEEERRRRR'')') ->> 'error' = 'NO_SETUP_CODE');
create table t.flag (ok boolean);
do $$ begin perform private.admin_panel_setup('KN-SAAAAA'); insert into t.flag values (false);
exception when sqlstate '22023' then insert into t.flag values (true); end $$;
select t.ok('A4. код установки (SQL Editor) не выдаётся не-владельцу', (select ok from t.flag));

-- установка пароля по одноразовому коду (как в SQL Editor)
select private.admin_panel_setup('KN-WAAAAA') ->> 'setup_code' as code1 \gset
insert into t.secrets values ('setup_code', :'code1');
select t.ok('A5. код установки: формат XXXX-XXXX-XXXX, в базе только sha256', :'code1' ~ '^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$'
  and (select setup_hash = private.panel_sha256(replace(:'code1', '-', '')) from private.owner_panel_secrets where user_id = :'uo'));
select t.ok('A5. неверный код → WRONG_CODE', t.api('select public.owner_panel_setup(''ABCD-EFGH-JKMN'', ''QQQQQWWWWWEEEEERRRRR'')') ->> 'error' = 'WRONG_CODE');
select t.ok('A5. слабый пароль (короткий / не тот алфавит) → WEAK_PASSWORD',
  t.api('select public.owner_panel_setup(' || t.q(:'code1') || ', ''password123'')') ->> 'error' = 'WEAK_PASSWORD'
  and t.api('select public.owner_panel_setup(' || t.q(:'code1') || ', ''QQQQQWWWWWEEEEERRRR0'')') ->> 'error' = 'WEAK_PASSWORD');
select t.ok('A5. пароль, совпадающий с ключом аккаунта → SAME_AS_KEY', t.api('select public.owner_panel_setup(' || t.q(:'code1') || ', ''KEYAB-CDEFG-HJKMN-PQRST'')') ->> 'error' = 'SAME_AS_KEY');
\set pw1 'HJKMN-PQRST-23456-WXYZA'
insert into t.secrets values ('password1', 'HJKMNPQRST23456WXYZA'), ('password1f', :'pw1');
select t.api('select public.owner_panel_setup(' || t.q(lower(:'code1')) || ', ' || t.q(:'pw1') || ')') as set1 \gset
select :'set1'::jsonb ->> 'session' as tok1 \gset
insert into t.secrets values ('session1', :'tok1');
select t.ok('A5. верный код (регистр не важен) → пароль установлен, выдана сессия (64 hex), 12 часов', :'set1'::jsonb ->> 'result' = 'ok'
  and :'tok1' ~ '^[0-9a-f]{64}$' and (:'set1'::jsonb ->> 'expires_at')::timestamptz between now() + interval '11 hours 59 minutes' and now() + interval '12 hours 1 minute', :'set1');
select t.ok('A5. в базе — только bcrypt-отпечаток пароля и sha256 сессии; код установки погашен',
  (select password_hash like '$2%' and setup_hash is null from private.owner_panel_secrets where user_id = :'uo')
  and (select token_hash = private.panel_sha256(:'tok1') from private.owner_panel_sessions where user_id = :'uo'));
select t.ok('A5. повторно тем же кодом — NO_SETUP_CODE', t.api('select public.owner_panel_setup(' || t.q(:'code1') || ', ''QQQQQWWWWWEEEEERRRRR'')') ->> 'error' = 'NO_SETUP_CODE');

-- вход постоянным паролем
select t.api('select public.owner_unlock(''HJKMN-PQRST-23456-WXYZB'')') as w1 \gset
select t.ok('A6. неверный пароль → WRONG_PASSWORD, без подсказок', :'w1'::jsonb ->> 'error' = 'WRONG_PASSWORD'
  and :'w1'::jsonb - 'error' - 'locked_until' = '{}'::jsonb, :'w1');
select t.api('select public.owner_unlock(''hjkmnpqrst23456wxyza'')') ->> 'session' as tok2 \gset
insert into t.secrets values ('session2', :'tok2');
select t.ok('A6. верный пароль (дефисы и регистр не важны) → сессия; панель отвечает', :'tok2' ~ '^[0-9a-f]{64}$'
  and t.api('select public.owner_overview(' || t.q(:'tok2') || ')') ? 'students');
select t.ok('A6. пароль постоянный: верный пароль снова работает, сессии независимы', t.api('select public.owner_unlock(' || t.q(:'pw1') || ')') ->> 'result' = 'ok'
  and t.api('select public.owner_overview(' || t.q(:'tok1') || ')') ? 'students');
select t.ok('A6. счётчик неверных попыток сброшен после успешного входа', (select failed_count = 0 from private.owner_panel_secrets where user_id = :'uo'));

-- сессия привязана к сессии входа и к аккаунту
select t.login(:'uo') as so2 \gset
select t.as_user(:'uo', :'so2');
select t.ok('A7. та же сессия панели из другой сессии входа (другое устройство) → PANEL_LOCKED', t.api('select public.owner_overview(' || t.q(:'tok2') || ')') ->> 'error' = 'PANEL_LOCKED');
select t.as_user(:'us', :'ss');
select t.ok('A7. ключ сессии владельца у ученика → FORBIDDEN', t.api('select public.owner_overview(' || t.q(:'tok2') || ')') ->> 'error' = 'FORBIDDEN');
select t.as_user(:'uo', :'so');
-- истечение: 12 часов от входа и 2 часа без действий
update private.owner_panel_sessions set last_used_at = now() - interval '2 hours 1 minute' where token_hash = private.panel_sha256(:'tok1');
select t.ok('A7. 2 часа без действий → PANEL_LOCKED', t.api('select public.owner_overview(' || t.q(:'tok1') || ')') ->> 'error' = 'PANEL_LOCKED');
update private.owner_panel_sessions set expires_at = now() - interval '1 second' where token_hash = private.panel_sha256(:'tok2');
select t.ok('A7. 12 часов прошли → PANEL_LOCKED (тот же пароль снова открывает)', t.api('select public.owner_overview(' || t.q(:'tok2') || ')') ->> 'error' = 'PANEL_LOCKED'
  and t.api('select public.owner_unlock(' || t.q(:'pw1') || ')') ->> 'result' = 'ok');
select t.api('select public.owner_unlock(' || t.q(:'pw1') || ')') ->> 'session' as tok3 \gset
select t.ok('A8. выход из панели (owner_lock) → ключ недействителен', t.api('select public.owner_lock(' || t.q(:'tok3') || ')') ->> 'result' = 'ok'
  and t.api('select public.owner_overview(' || t.q(:'tok3') || ')') ->> 'error' = 'PANEL_LOCKED');
select t.api('select public.owner_unlock(' || t.q(:'pw1') || ')') ->> 'session' as tok4 \gset
select t.api('select public.owner_unlock(' || t.q(:'pw1') || ')') ->> 'session' as tok5 \gset
select t.ok('A8. «выйти на всех устройствах» → все сессии недействительны', (t.api('select public.owner_lock_all(' || t.q(:'tok4') || ')') ->> 'sessions')::int >= 2
  and t.api('select public.owner_overview(' || t.q(:'tok5') || ')') ->> 'error' = 'PANEL_LOCKED');
-- выход из аккаунта (сессия входа удалена) — панель тоже закрыта, хотя JWT ещё действителен
select t.api('select public.owner_unlock(' || t.q(:'pw1') || ')') ->> 'session' as tok6 \gset
delete from auth.sessions where id = :'so';
select t.ok('A8. выход из обычного аккаунта → FORBIDDEN даже с ключом панели', t.api('select public.owner_overview(' || t.q(:'tok6') || ')') ->> 'error' = 'FORBIDDEN'
  and t.api('select public.owner_unlock(' || t.q(:'pw1') || ')') ->> 'error' = 'FORBIDDEN');
select t.login(:'uo') as so \gset
select t.as_user(:'uo', :'so');

-- смена пароля
select t.api('select public.owner_unlock(' || t.q(:'pw1') || ')') ->> 'session' as tok7 \gset
select t.api('select public.owner_unlock(' || t.q(:'pw1') || ')') ->> 'session' as tok8 \gset
\set pw2 'ZYXWV-TSRQP-NMKJH-98765'
insert into t.secrets values ('password2', 'ZYXWVTSRQPNMKJH98765');
select t.ok('A9. смена пароля: неверный текущий → WRONG_PASSWORD; тот же пароль → SAME_PASSWORD',
  t.api('select public.owner_change_password(' || t.q(:'tok7') || ', ''AAAAA-AAAAA-AAAAA-AAAAA'', ' || t.q(:'pw2') || ')') ->> 'error' = 'WRONG_PASSWORD'
  and t.api('select public.owner_change_password(' || t.q(:'tok7') || ', ' || t.q(:'pw1') || ', ' || t.q(:'pw1') || ')') ->> 'error' = 'SAME_PASSWORD');
select t.api('select public.owner_change_password(' || t.q(:'tok7') || ', ' || t.q(:'pw1') || ', ' || t.q(:'pw2') || ')') ->> 'session' as tok9 \gset
select t.ok('A9. после смены: старые сессии закрыты, новая работает', t.api('select public.owner_overview(' || t.q(:'tok8') || ')') ->> 'error' = 'PANEL_LOCKED'
  and t.api('select public.owner_overview(' || t.q(:'tok7') || ')') ->> 'error' = 'PANEL_LOCKED'
  and t.api('select public.owner_overview(' || t.q(:'tok9') || ')') ? 'students');
select t.ok('A9. старый пароль больше не подходит, новый — да', t.api('select public.owner_unlock(' || t.q(:'pw1') || ')') ->> 'error' = 'WRONG_PASSWORD'
  and t.api('select public.owner_unlock(' || t.q(:'pw2') || ')') ->> 'result' = 'ok');

-- перебор: 5 неверных подряд → пауза 15 минут; во время паузы даже верный пароль не проверяется
update private.owner_panel_secrets set failed_count = 0 where user_id = :'uo';
create table t.brute as select i, t.api('select public.owner_unlock(''AAAAA-BBBBB-CCCCC-DDDD' || i || ''')') r from generate_series(2, 7) i;
select t.ok('A11. попытки 1–4 → WRONG_PASSWORD, 5-я → LOCKED на ~15 минут, 6-я → LOCKED',
  (select array_agg(r ->> 'error' order by i) from t.brute) = array['WRONG_PASSWORD','WRONG_PASSWORD','WRONG_PASSWORD','WRONG_PASSWORD','LOCKED','LOCKED']
  and (select (r ->> 'locked_until')::timestamptz between now() + interval '14 minutes' and now() + interval '16 minutes' from t.brute where i = 6),
  (select string_agg(r::text, ' ') from t.brute));
select t.ok('A11. во время паузы верный пароль → LOCKED (перезагрузка страницы не поможет: счётчик на сервере)',
  t.api('select public.owner_unlock(' || t.q(:'pw2') || ')') ->> 'error' = 'LOCKED'
  and (t.api('select public.owner_panel_state()') ->> 'locked_until') is not null);
update private.owner_panel_secrets set locked_until = now() - interval '1 second' where user_id = :'uo';
create table t.brute2 as select i, t.api('select public.owner_unlock(''AAAAA-BBBBB-CCCCC-DDDD' || i || ''')') r from generate_series(2, 6) i;
select t.ok('A11. вторая серия из 5 → пауза уже 1 час (нарастает)',
  (select (r ->> 'locked_until')::timestamptz between now() + interval '59 minutes' and now() + interval '61 minutes' from t.brute2 where i = 6));
select t.ok('A11. журнал безопасности: неверные попытки и паузы записаны', (select count(*) from private.owner_security_log where user_id = :'uo' and event = 'unlock_failed') >= 11
  and (select count(*) from private.owner_security_log where user_id = :'uo' and event = 'locked') = 2);
update private.owner_panel_secrets set locked_until = null where user_id = :'uo';
select t.api('select public.owner_unlock(' || t.q(:'pw2') || ')') ->> 'session' as tok \gset
insert into t.secrets values ('session_main', :'tok');
select t.ok('A11. после паузы верный пароль открывает; счётчики сброшены', :'tok' ~ '^[0-9a-f]{64}$'
  and (select failed_count = 0 and lock_level = 0 from private.owner_panel_secrets where user_id = :'uo'));
select t.ok('A11. неверный код установки тоже считается попыткой (общий счётчик)', (select count(*) from private.owner_security_log
  where user_id = :'uo' and event = 'unlock_failed' and details ->> 'what' = 'setup_code') = 1);

-- ======================================================================
-- Подписки
-- ======================================================================
create function t.p(p_sql text) returns jsonb language sql as $$ select t.api(replace(p_sql, '$S', quote_literal(current_setting('t.tok')))) $$;
select set_config('t.tok', :'tok', false);
select t.p('select public.owner_preview($S, ''kn-saaaaa'', ''grant'', 30, 20)') as pv \gset
select t.ok('S13. предпросмотр выдачи: ID нормализован, 30 дней, 20 генераций, даты считает сервер', :'pv'::jsonb ->> 'kn_id' = 'KN-SAAAAA'
  and (:'pv'::jsonb ->> 'days')::int = 30 and (:'pv'::jsonb ->> 'ai_quota')::int = 20
  and (:'pv'::jsonb ->> 'ends_at')::timestamptz - (:'pv'::jsonb ->> 'starts_at')::timestamptz = interval '30 days', :'pv');
select gen_random_uuid() as rq1 \gset
select t.p('select public.owner_grant($S, ' || t.q(:'rq1') || ', ''KN-SAAAAA'', 30, 20, ''оплата 26.10'')') as g \gset
select t.ok('S13. выдача: granted, статус ученика с сервера — paid, 20 генераций', :'g'::jsonb ->> 'result' = 'granted'
  and :'g'::jsonb -> 'access' ->> 'status' = 'paid' and (:'g'::jsonb -> 'access' ->> 'ai_quota')::int = 20, :'g');
select t.ok('S13. журнал: grant записан от имени панели (actor panel:KN-WAAAAA)', exists (select 1 from private.access_log
  where action = 'grant' and user_id = :'us' and actor = 'panel:KN-WAAAAA'));
select t.ok('S18. повтор того же запроса → прежний результат (replayed), второй выдачи нет',
  t.p('select public.owner_grant($S, ' || t.q(:'rq1') || ', ''KN-SAAAAA'', 30, 20, ''оплата 26.10'')') ->> 'replayed' = 'true'
  and (select count(*) from private.access_grants where user_id = :'us' and kind = 'paid') = 1);
select t.ok('S18. тот же request_id с другими данными → REQUEST_REUSED', t.p('select public.owner_grant($S, ' || t.q(:'rq1') || ', ''KN-SAAAAA'', 7, 1)') ->> 'error' = 'REQUEST_REUSED');
select t.ok('S13. повторная выдача при действующем сроке → ALREADY_ACTIVE (предпросмотр и действие)',
  t.p('select public.owner_preview($S, ''KN-SAAAAA'', ''grant'', 30, 20)') ->> 'error' = 'ALREADY_ACTIVE'
  and t.p('select public.owner_grant($S, gen_random_uuid(), ''KN-SAAAAA'', 30, 20)') ->> 'error' = 'ALREADY_ACTIVE');
-- досрочное продление: встык
select t.p('select public.owner_preview($S, ''KN-SAAAAA'', ''extend'', 30, 10)') as pe \gset
select t.ok('S14. предпросмотр продления: начало = конец текущего срока', (:'pe'::jsonb ->> 'starts_at')::timestamptz
  = (select ends_at from private.access_grants where user_id = :'us' and kind = 'paid') and :'pe'::jsonb ->> 'starts_after_current' = 'true', :'pe');
select t.p('select public.owner_extend($S, gen_random_uuid(), ''KN-SAAAAA'', 30, 10, null, ' || t.q(:'pe'::jsonb ->> 'starts_at') || ')') as e \gset
select t.ok('S14. продление: extended; новый срок встык, оплаченные дни целы; лимит текущего срока прежний (20)', :'e'::jsonb ->> 'result' = 'extended'
  and (:'e'::jsonb -> 'grant' ->> 'starts_at')::timestamptz = (:'pe'::jsonb ->> 'starts_at')::timestamptz
  and (:'e'::jsonb -> 'access' ->> 'ai_quota')::int = 20, :'e');
-- предпросмотр устарел: срок изменили (SQL Editor) между предпросмотром и подтверждением
select t.p('select public.owner_preview($S, ''KN-SAAAAA'', ''extend'', 7, 5)') as pe2 \gset
select private.admin_extend('KN-SAAAAA', null, 7, 5, 'параллельно из SQL Editor') ->> 'result' as x \gset
select (select count(*) from private.access_grants where user_id = :'us') as ng \gset
select t.ok('S21. подтверждение устаревшего предпросмотра → STATE_CHANGED, продления нет',
  t.p('select public.owner_extend($S, gen_random_uuid(), ''KN-SAAAAA'', 7, 5, null, ' || t.q(:'pe2'::jsonb ->> 'starts_at') || ')') ->> 'error' = 'STATE_CHANGED'
  and (select count(*) from private.access_grants where user_id = :'us') = :ng);
select t.ok('S21. продление без ожидаемой даты при действующем сроке → STATE_CHANGED (владелец должен видеть даты)',
  t.p('select public.owner_extend($S, gen_random_uuid(), ''KN-SAAAAA'', 7, 5)') ->> 'error' = 'STATE_CHANGED');
select t.ok('S14. продление того, кто ещё не платил → NO_PAID_YET', t.p('select public.owner_preview($S, ''KN-SBAAAA'', ''extend'', 30, 10)') ->> 'error' = 'NO_PAID_YET'
  and t.p('select public.owner_extend($S, gen_random_uuid(), ''KN-SBAAAA'', 30, 10)') ->> 'error' = 'NO_PAID_YET');
-- отзыв: предпросмотр показывает ВСЕ сроки, которые снимутся
select t.p('select public.owner_preview($S, ''KN-SAAAAA'', ''revoke'')') as pr \gset
select t.ok('S15. предпросмотр отзыва: 3 срока (действующий + 2 будущих) — все будут сняты', (:'pr'::jsonb ->> 'periods_count')::int = 3, :'pr');
select t.ok('S21. отзыв с устаревшим числом сроков → STATE_CHANGED', t.p('select public.owner_revoke($S, gen_random_uuid(), ''KN-SAAAAA'', null, 2)') ->> 'error' = 'STATE_CHANGED'
  and t.p('select public.owner_revoke($S, gen_random_uuid(), ''KN-SAAAAA'')') ->> 'error' = 'STATE_CHANGED');
select t.p('select public.owner_revoke($S, gen_random_uuid(), ''KN-SAAAAA'', ''ошибка'', 3)') as rv \gset
select t.ok('S15. отзыв: revoked 3, ученик — expired (revoked) с сервера; строки и журнал остались', :'rv'::jsonb ->> 'result' = 'revoked'
  and (:'rv'::jsonb ->> 'revoked')::int = 3 and :'rv'::jsonb -> 'access' ->> 'status' in ('trial', 'expired')
  and (select count(*) from private.access_grants where user_id = :'us' and kind = 'paid') = 3, :'rv');
select t.ok('S15. после отзыва можно выдать заново (вернуть доступ)', t.p('select public.owner_grant($S, gen_random_uuid(), ''KN-SAAAAA'', 7, 3)') ->> 'result' = 'granted');
select t.ok('S15. отзывать нечего → NOTHING_TO_REVOKE', t.p('select public.owner_preview($S, ''KN-SBAAAA'', ''revoke'')') ->> 'error' = 'NOTHING_TO_REVOKE');
-- неверные данные
select t.ok('S16. неверный ID (формат, символы вне алфавита, инъекция) → INVALID_ID', t.p('select public.owner_preview($S, ''KN-0000'', ''grant'', 30, 20)') ->> 'error' = 'INVALID_ID'
  and t.p('select public.owner_grant($S, gen_random_uuid(), ''KN-OOOOOO'', 30, 20)') ->> 'error' = 'INVALID_ID'
  and t.p('select public.owner_grant($S, gen_random_uuid(), ''''''; drop table private.access_grants; --'', 30, 20)') ->> 'error' = 'INVALID_ID'
  and to_regclass('private.access_grants') is not null);
select t.ok('S17. несуществующий ID → USER_NOT_FOUND', t.p('select public.owner_preview($S, ''KN-ZZZZZZ'', ''grant'', 30, 20)') ->> 'error' = 'USER_NOT_FOUND'
  and t.p('select public.owner_grant($S, gen_random_uuid(), ''KN-ZZZZZZ'', 30, 20)') ->> 'error' = 'USER_NOT_FOUND');
select t.ok('S20. недопустимый срок/лимит → INVALID_INPUT с понятным сообщением, ничего не выдано',
  t.p('select public.owner_grant($S, gen_random_uuid(), ''KN-SBAAAA'', 0, 20)') ->> 'error' = 'INVALID_INPUT'
  and t.p('select public.owner_grant($S, gen_random_uuid(), ''KN-SBAAAA'', 401, 20)') ->> 'error' = 'INVALID_INPUT'
  and t.p('select public.owner_preview($S, ''KN-SBAAAA'', ''grant'', 30, -1)') ->> 'error' = 'INVALID_INPUT'
  and length(t.p('select public.owner_grant($S, gen_random_uuid(), ''KN-SBAAAA'', 0, 20)') ->> 'message') > 5
  and not exists (select 1 from private.access_grants where user_id = :'us2' and kind = 'paid'));
select t.ok('S20. неожиданная ошибка сервера → SERVER_ERROR без текста ошибки (ничего не раскрывается)',
  private.panel_error('XX000', 'internal detail') = '{"error": "SERVER_ERROR", "message": null}'::jsonb);
select t.ok('S20. отказы панели записаны в журнал (panel_refused)', (select count(*) from private.access_log where action = 'panel_refused') >= 5);
select t.ok('S13. без идентификатора операции → INVALID_INPUT', t.p('select public.owner_grant($S, null, ''KN-SBAAAA'', 30, 20)') ->> 'error' = 'INVALID_INPUT');

-- ======================================================================
-- Приглашения
-- ======================================================================
select gen_random_uuid() as ri1 \gset
select t.p('select public.owner_invite_create($S, ' || t.q(:'ri1') || ', ''Ваня 7Б'', 7)') as ic \gset
select :'ic'::jsonb ->> 'code' as icode \gset
insert into t.secrets values ('invite_code', :'icode'), ('invite_code_n', replace(:'icode', '-', ''));
select t.ok('I22. создание: код XXXX-XXXX-XXXX из алфавита кодов, срок 7 дней, подпись', :'icode' ~ '^[ABCDEFGHJKMNPQRSTWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTWXYZ2-9]{4}$'
  and (:'ic'::jsonb ->> 'expires_at')::timestamptz between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour'
  and :'ic'::jsonb ->> 'label' = 'Ваня 7Б', :'ic');
select t.ok('I22. в базе только sha256 кода; источник — панель', exists (select 1 from private.beta_invites i join private.invite_meta m using (code_hash)
  where i.code_hash = private.invite_code_hash(:'icode') and m.source = 'panel' and m.created_by = :'uo' and i.quota = 1));
select t.ok('I29. повтор запроса создания → без кода (код показывается один раз), второго кода нет',
  t.p('select public.owner_invite_create($S, ' || t.q(:'ri1') || ', ''Ваня 7Б'', 7)') ->> 'code' is null
  and (select count(*) from private.invite_meta where source = 'panel') = 1);
select t.register_with(:'icode', 'KN-NAAAAA') as un \gset
select t.ok('I23. регистрация по коду из панели: аккаунт + пробный период', :'un' <> '' and exists (select 1 from private.access_grants where user_id = :'un' and kind = 'trial'));
select t.ok('I26. повторная регистрация тем же кодом — отказ', (public.register_invite_begin(:'icode', 'KN-NBAAAA', repeat('d', 64)) ->> 'result') <> 'reserved');
select t.p('select public.owner_invites($S)') as il \gset
select t.ok('I23. список: код использован — ID ученика KN-NAAAAA', exists (select 1 from jsonb_array_elements(:'il'::jsonb -> 'items') x
  where x ->> 'status' = 'used' and x ->> 'redeemed_kn' = 'KN-NAAAAA' and x ->> 'label' = 'Ваня 7Б'), :'il');
select t.p('select public.owner_invite_create($S, gen_random_uuid(), ''истечёт'', 1)') ->> 'code' as icode2 \gset
select t.p('select public.owner_invite_create($S, gen_random_uuid(), ''отзовём'', 30)') as ic3 \gset
insert into t.secrets values ('invite_code2', :'icode2'), ('invite_code3', :'ic3'::jsonb ->> 'code');
update private.beta_invites set expires_at = now() - interval '1 minute' where code_hash = private.invite_code_hash(:'icode2');
select t.ok('I24. истёкший код: регистрация невозможна, статус «истекло», отзыв → ALREADY_EXPIRED',
  (public.register_invite_begin(:'icode2', 'KN-NCAAAA', repeat('d', 64)) ->> 'result') <> 'reserved'
  and exists (select 1 from jsonb_array_elements(t.p('select public.owner_invites($S, ''expired'')') -> 'items') x where x ->> 'label' = 'истечёт')
  and t.p('select public.owner_invite_revoke($S, gen_random_uuid(), ' || t.q((select m.id::text from private.invite_meta m where m.code_hash = private.invite_code_hash(:'icode2'))) || ')') ->> 'error' = 'ALREADY_EXPIRED');
select t.p('select public.owner_invite_revoke($S, gen_random_uuid(), ' || t.q(:'ic3'::jsonb ->> 'invite_id') || ')') as rv3 \gset
select t.ok('I25. отзыв неиспользованного: revoked; регистрация по нему невозможна; статус «отозвано»', :'rv3'::jsonb ->> 'result' = 'revoked'
  and (public.register_invite_begin(:'ic3'::jsonb ->> 'code', 'KN-NDAAAA', repeat('d', 64)) ->> 'result') <> 'reserved'
  and exists (select 1 from jsonb_array_elements(t.p('select public.owner_invites($S, ''revoked'')') -> 'items') x where x ->> 'label' = 'отзовём'), :'rv3');
select t.ok('I25. повторный отзыв → ALREADY_REVOKED; отзыв использованного → ALREADY_USED; чужой id → INVITE_NOT_FOUND',
  t.p('select public.owner_invite_revoke($S, gen_random_uuid(), ' || t.q(:'ic3'::jsonb ->> 'invite_id') || ')') ->> 'error' = 'ALREADY_REVOKED'
  and t.p('select public.owner_invite_revoke($S, gen_random_uuid(), ' || t.q(:'ic'::jsonb ->> 'invite_id') || ')') ->> 'error' = 'ALREADY_USED'
  and t.p('select public.owner_invite_revoke($S, gen_random_uuid(), gen_random_uuid())') ->> 'error' = 'INVITE_NOT_FOUND');
-- код, по которому прямо сейчас идёт регистрация, не отзывается
select t.p('select public.owner_invite_create($S, gen_random_uuid(), ''в процессе'', 7)') as ic4 \gset
insert into t.secrets values ('invite_code4', :'ic4'::jsonb ->> 'code');
select public.register_invite_begin(:'ic4'::jsonb ->> 'code', 'KN-NEAAAA', repeat('e', 64)) ->> 'result' as x \gset
select t.ok('I25. идёт регистрация (резерв моложе 15 минут) → IN_PROGRESS', t.p('select public.owner_invite_revoke($S, gen_random_uuid(), ' || t.q(:'ic4'::jsonb ->> 'invite_id') || ')') ->> 'error' = 'IN_PROGRESS');
-- код из скрипта tools/ff-invite-codes.mjs тоже виден и отзывается
select private.admin_add_beta_invite(private.invite_code_hash('SCRIPTCODE01'), 1, 'из скрипта', now() + interval '3 days');
select t.ok('I22. код из скрипта виден в списке (source=script) и отзывается из панели', exists (select 1 from jsonb_array_elements(t.p('select public.owner_invites($S, ''active'')') -> 'items') x
  where x ->> 'label' = 'из скрипта' and x ->> 'source' = 'script')
  and t.p('select public.owner_invite_revoke($S, gen_random_uuid(), ' || t.q((select id::text from private.invite_meta where code_hash = private.invite_code_hash('SCRIPTCODE01'))) || ')') ->> 'result' = 'revoked');
select t.ok('I22. неверные данные: срок 0 или 61 день, подпись > 100 символов → INVALID_INPUT',
  t.p('select public.owner_invite_create($S, gen_random_uuid(), ''x'', 0)') ->> 'error' = 'INVALID_INPUT'
  and t.p('select public.owner_invite_create($S, gen_random_uuid(), ''x'', 61)') ->> 'error' = 'INVALID_INPUT'
  and t.p('select public.owner_invite_create($S, gen_random_uuid(), ' || t.q(repeat('я', 101)) || ', 7)') ->> 'error' = 'INVALID_INPUT');
-- дневной предел: 10 кодов из панели за 24 часа (уже создано 4)
create table t.inv as select i, t.p('select public.owner_invite_create($S, gen_random_uuid(), ''пакет'', 7)') r from generate_series(1, 7) i;
insert into t.secrets select 'invite_batch', r ->> 'code' from t.inv where r ? 'code';
select t.ok('I27. дневной предел: ещё 6 созданы (всего 10), 7-й → DAILY_LIMIT', (select count(*) from t.inv where r ->> 'result' = 'created') = 6
  and (select r ->> 'error' from t.inv where i = 7) = 'DAILY_LIMIT', (select string_agg(coalesce(r ->> 'error', 'ok'), ',') from t.inv));
update private.invite_meta set created_at = created_at - interval '25 hours' where source = 'panel';
select t.ok('I27. через сутки можно снова', t.p('select public.owner_invite_create($S, gen_random_uuid(), ''завтра'', 7)') ->> 'result' = 'created');

-- ======================================================================
-- Данные
-- ======================================================================
select t.p('select public.owner_students($S)') as sl \gset
select t.ok('D30. список: только аккаунты с ID (без гостей), поля статуса с сервера', (:'sl'::jsonb ->> 'total')::int
  = (select count(*) from auth.users where not is_anonymous and email like 'id-kn-%')
  and not exists (select 1 from jsonb_array_elements(:'sl'::jsonb -> 'items') x where not (x ? 'kn_id' and x ? 'status' and x ? 'ends_at' and x ? 'ai_remaining' and x ? 'registered_at'))
  and exists (select 1 from jsonb_array_elements(:'sl'::jsonb -> 'items') x where x ->> 'kn_id' = 'KN-FFAAAA' and x ->> 'kind' = 'legacy'), :'sl');
select t.ok('D31. поиск: полный ID, часть, строчные, с «KN-», без результата',
  (t.p('select public.owner_students($S, ''KN-SAAAAA'')') ->> 'total')::int = 1
  and (t.p('select public.owner_students($S, ''sb'')') ->> 'total')::int = 1
  and (t.p('select public.owner_students($S, ''kn-sc'')') ->> 'total')::int = 1
  and (t.p('select public.owner_students($S, ''QQQQ'')') ->> 'total')::int = 0
  and (t.p('select public.owner_students($S, ''%'')') ->> 'total')::int = (:'sl'::jsonb ->> 'total')::int);
select t.ok('D31. фильтры: платные, пробные, F&F, владелец', (t.p('select public.owner_students($S, null, ''paid'')') ->> 'total')::int = 1
  and (t.p('select public.owner_students($S, null, ''owner'')') ->> 'total')::int = 1
  and (t.p('select public.owner_students($S, null, ''legacy'')') ->> 'total')::int = 1
  and (t.p('select public.owner_students($S, null, ''trial'')') ->> 'total')::int >= 2
  and t.p('select public.owner_students($S, null, ''bad'')') ->> 'error' = 'INVALID_INPUT');
select t.ok('D32. страницы: 2+2 разные, общее число то же', (select count(*) from (
    select x ->> 'kn_id' from jsonb_array_elements(t.p('select public.owner_students($S, null, ''all'', 2, 0)') -> 'items') x
    union select x ->> 'kn_id' from jsonb_array_elements(t.p('select public.owner_students($S, null, ''all'', 2, 2)') -> 'items') x) y) = 4
  and (t.p('select public.owner_students($S, null, ''all'', 500, 0)') ->> 'limit')::int = 50);
select t.p('select public.owner_student($S, ''KN-SAAAAA'')') as sc \gset
select t.ok('D30. карточка: сроки, история (выдача, продление, отзыв), без внутренних id', jsonb_array_length(:'sc'::jsonb -> 'grants') = 5
  and (select count(*) from jsonb_array_elements(:'sc'::jsonb -> 'history') h where h ->> 'action' in ('grant', 'extend', 'revoke')) >= 4
  and not (:'sc'::jsonb -> 'grants' -> 0 ? 'id'), :'sc');
select t.p('select public.owner_history($S, 5, 0)') as h1 \gset
select t.ok('D33. история: новые сверху, страницы, события панели и безопасности', jsonb_array_length(:'h1'::jsonb -> 'items') = 5
  and (:'h1'::jsonb ->> 'total')::int > 20
  and exists (select 1 from jsonb_array_elements(t.p('select public.owner_history($S, 100, 0)') -> 'items') x where x ->> 'type' = 'invite_create' and x ->> 'by' = 'panel')
  and exists (select 1 from jsonb_array_elements(t.p('select public.owner_history($S, 100, 0)') -> 'items') x where x ->> 'type' = 'grant' and x ->> 'by' = 'panel' and x ->> 'kn_id' = 'KN-SAAAAA')
  and exists (select 1 from jsonb_array_elements(t.p('select public.owner_history($S, 100, 0)') -> 'items') x where x ->> 'type' = 'locked')
  and exists (select 1 from jsonb_array_elements(t.p('select public.owner_history($S, 100, 0)') -> 'items') x where x ->> 'type' = 'password_changed'), :'h1');
-- AI: реальные значения; автостоп при массовом сбое (2 пользователя, 3 тех. неудачи)
select t.p('select public.owner_ai($S)') as ai0 \gset
select t.ok('D34. ИИ: бюджет 40, использовано 7, остаток 33, работает (как в ai_limits)', (:'ai0'::jsonb ->> 'budget')::int = 40
  and (:'ai0'::jsonb ->> 'used')::int = 7 and (:'ai0'::jsonb ->> 'remaining')::int = 33 and :'ai0'::jsonb ->> 'state' = 'ok'
  and jsonb_array_length(:'ai0'::jsonb -> 'days') = 7, :'ai0');
insert into private.generation_starts (user_id, op_key, started_at, outcome, error_code, finished_at) values
  (:'us2', 'a', now() - interval '20 minutes', 'failed', 'AI_TIMEOUT', now() - interval '19 minutes'),
  (:'us2', 'b', now() - interval '10 minutes', 'failed', 'AI_ERROR', now() - interval '9 minutes'),
  (:'us3', 'c', now() - interval '5 minutes', 'failed', 'AI_ERROR', now() - interval '4 minutes');
select t.p('select public.owner_ai($S)') as ai1 \gset
select t.ok('D34. автостоп: state=breaker, причина mass, снимется не позже чем через ~10 минут (первая неудача + 30 мин)',
  :'ai1'::jsonb ->> 'state' = 'breaker' and :'ai1'::jsonb -> 'breaker' ->> 'reason' = 'mass' and private.ai_breaker()
  and abs(extract(epoch from (:'ai1'::jsonb -> 'breaker' ->> 'until_at_most')::timestamptz - (now() + interval '10 minutes'))) < 5
  and (:'ai1'::jsonb ->> 'tech_errors_24h')::int = 3, :'ai1');
select t.p('select public.owner_overview($S)') as ov \gset
select t.ok('D34. главная: ученики, подписки, ИИ, приглашения — реальные числа', (:'ov'::jsonb -> 'students' ->> 'total')::int = (:'sl'::jsonb ->> 'total')::int
  and (:'ov'::jsonb -> 'subscriptions' ->> 'active')::int = 1 and (:'ov'::jsonb -> 'subscriptions' ->> 'extensions_total')::int = 2
  and (:'ov'::jsonb -> 'ai' ->> 'remaining')::int = 33 and (:'ov'::jsonb -> 'invites' ->> 'used')::int = 5
  and (:'ov'::jsonb -> 'invites' ->> 'revoked')::int = 2, :'ov');
update private.access_grants set ends_at = now() + interval '3 days' where user_id = :'us' and kind = 'paid' and revoked_at is null;
select t.ok('D34. «истекают в ближайшие 7 дней» считается', (t.p('select public.owner_overview($S)') -> 'subscriptions' ->> 'expiring_7d')::int = 1);
select t.ok('D34. панель не меняет бюджет и настройки ИИ', (select (l.max_total_starts, l.total_starts, l.ai_enabled, l.max_in_flight)
  = (b.max_total_starts, b.total_starts, b.ai_enabled, b.max_in_flight) from private.ai_limits l, t.limits_before b));

-- D35. ни один ответ панели и ни одна строка журналов не содержит паролей, ключей, кодов, отпечатков и служебных адресов
create table t.responses (r text);
insert into t.responses select t.p(x)::text from unnest(array[
  'select public.owner_overview($S)', 'select public.owner_students($S, null, ''all'', 50, 0)', 'select public.owner_student($S, ''KN-SAAAAA'')',
  'select public.owner_student($S, ''KN-NAAAAA'')', 'select public.owner_invites($S, ''all'', 50, 0)', 'select public.owner_ai($S)',
  'select public.owner_history($S, 100, 0)', 'select public.owner_panel_state()', 'select public.owner_preview($S, ''KN-SAAAAA'', ''revoke'')']) x;
insert into t.responses select details::text from private.access_log union all select details::text from private.owner_security_log
  union all select coalesce(result::text, '') || args::text from private.owner_requests;
select t.ok('D35. нет паролей, кодов, ключей сессий в ответах, журналах и сохранённых результатах',
  not exists (select 1 from t.responses r, t.secrets s where s.value <> '' and position(s.value in r.r) > 0),
  (select string_agg(distinct s.what, ',') from t.responses r, t.secrets s where s.value <> '' and position(s.value in r.r) > 0));
select t.ok('D35. нет служебных адресов, bcrypt и sha256-отпечатков', not exists (select 1 from t.responses where r like '%konspekt.invalid%'
  or r ~ '\$2[aby]\$' or r ~ '[0-9a-f]{64}' or r like '%encrypted_password%' or r like '%code_hash%' or r like '%token_hash%'),
  (select left(r, 200) from t.responses where r like '%konspekt.invalid%' or r ~ '\$2[aby]\$' or r ~ '[0-9a-f]{64}' limit 1));

-- отзыв роли владельца — панель закрыта сразу
select t.ok('A10. отзыв роли владельца → FORBIDDEN даже с действующей сессией', (select private.admin_revoke('KN-WAAAAA', 'тест', 'owner') ->> 'result') = 'revoked'
  and t.p('select public.owner_overview($S)') ->> 'error' = 'FORBIDDEN' and (t.api('select public.owner_panel_state()') ->> 'owner')::boolean = false);
select private.admin_set_owner('KN-WAAAAA') ->> 'result' as x \gset
-- сброс забытого пароля (SQL Editor): старый пароль и сессии недействительны, новый — по новому коду
select t.api('select public.owner_unlock(' || t.q(:'pw2') || ')') ->> 'session' as tokr \gset
select private.admin_panel_setup('KN-WAAAAA') as reset \gset
insert into t.secrets values ('setup_code2', :'reset'::jsonb ->> 'setup_code');
select t.ok('A9. сброс пароля: result=reset; сессии закрыты; старый пароль → NOT_SET', :'reset'::jsonb ->> 'result' = 'reset'
  and t.api('select public.owner_overview(' || t.q(:'tokr') || ')') ->> 'error' = 'PANEL_LOCKED'
  and t.api('select public.owner_unlock(' || t.q(:'pw2') || ')') ->> 'error' = 'NOT_SET'
  and (t.api('select public.owner_panel_state()') ->> 'setup_pending')::boolean);
select t.ok('A9. код сброса истекает через 30 минут', (select setup_expires_at between now() + interval '29 minutes' and now() + interval '31 minutes' from private.owner_panel_secrets where user_id = :'uo'));
update private.owner_panel_secrets set setup_expires_at = now() - interval '1 second' where user_id = :'uo';
select t.ok('A9. истёкший код сброса → NO_SETUP_CODE', t.api('select public.owner_panel_setup(' || t.q(:'reset'::jsonb ->> 'setup_code') || ', ''QQQQQWWWWWEEEEERRRRR'')') ->> 'error' = 'NO_SETUP_CODE');
select t.ok('A0. права: owner_* — только authenticated (не anon, не public); внутренние — никому', not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'owner\_%' and (has_function_privilege('anon', p.oid, 'execute') or not has_function_privilege('authenticated', p.oid, 'execute')))
  and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'service_role']) r
     where n.nspname = 'private' and (p.proname like 'panel\_%' or p.proname like 'admin_panel%') and has_function_privilege(r, p.oid, 'execute')));
select t.ok('A0. все функции панели: SECURITY DEFINER только у owner_* и триггера, у всех search_path=''''', not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (p.proname like 'owner\_%' or p.proname like 'panel\_%' or p.proname like 'admin_panel%' or p.proname = 'invite_meta_on_insert')
       and n.nspname in ('public', 'private') and not coalesce(p.proconfig @> array['search_path=""'], false))
  and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.proname like 'panel\_%' and p.prosecdef));
select t.ok('A0. RLS включён на 5 новых таблицах, прав у ролей API нет', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'private' and c.relname in ('owner_panel_secrets', 'owner_panel_sessions', 'owner_security_log', 'owner_requests', 'invite_meta') and c.relrowsecurity) = 5
  and not exists (select 1 from information_schema.role_table_grants where table_schema = 'private'
   and table_name in ('owner_panel_secrets', 'owner_panel_sessions', 'owner_security_log', 'owner_requests', 'invite_meta')
   and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')));

select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok and info is not null then ' → ' || left(info, 400) else '' end from t.results order by n;
select 'ИТОГО: ' || count(*) filter (where ok) || ' PASS, ' || count(*) filter (where not ok) || ' FAIL' from t.results;
