-- v61.1: переход v59 → v61 на копии базы «как в production» (НЕ production).
-- Запуск на базе БЕЗ миграции v61: psql -v mig=<путь к 20261024150000_paid_access.sql> -f transition.test.sql
\set QUIET on
\pset tuples_only on
\pset format unaligned
set client_min_messages = warning;

create schema t;
create table t.results (n serial, name text, ok boolean, info text);
create function t.ok(p_name text, p_ok boolean, p_info text default null) returns void language sql as
  $$ insert into t.results (name, ok, info) values (p_name, coalesce(p_ok, false), p_info) $$;
create function t.note(p_uid uuid) returns uuid language sql as
  $$ insert into public.notes (user_id, status, stage) values (p_uid, 'processing', 'uploading') returning id $$;
create function t.start_old(p_uid uuid, p_note uuid) returns text language plpgsql as $$
declare r jsonb; begin set local role service_role; r := public.start_text_generation(p_uid, p_note, 300, 600, 2); reset role; return r ->> 'result'; end $$;
create function t.start(p_uid uuid, p_note uuid) returns text language plpgsql as $$
declare r jsonb; begin set local role service_role; execute 'select public.start_text_generation_v2($1, $2, 300, 600, 2)' into r using p_uid, p_note; reset role; return r ->> 'result'; end $$;
create function t.finish(p_note uuid, p_ok boolean) returns void language sql as
  $$ update public.notes set status = case when p_ok then 'ready' else 'failed' end, stage = case when p_ok then 'done' else 'failed' end where id = p_note $$;
create function t.me_old(p_uid uuid) returns jsonb language plpgsql as $$
declare r jsonb; begin perform set_config('request.jwt.claim.sub', p_uid::text, true); set local role authenticated;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into r from public.get_my_access() x; reset role; return r; end $$;
create function t.me(p_uid uuid) returns jsonb language plpgsql as $$
declare r jsonb; begin perform set_config('request.jwt.claim.sub', p_uid::text, true); set local role authenticated;
  execute 'select public.get_my_access_v2()' into r; reset role; return r; end $$;
-- регистрация по приглашению — так же, как Edge Function register-invite (и в v59, и в v61)
create function t.register(p_code text, p_kn text) returns uuid language plpgsql as $$
declare r jsonb; v uuid;
begin
  insert into private.beta_invites (code_hash, quota, expires_at) values (private.invite_code_hash(p_code), 1, now() + interval '7 days');
  r := public.register_invite_begin(p_code, p_kn, repeat('b', 64));
  insert into auth.users (email, raw_app_meta_data) values (private.kn_email(p_kn), jsonb_build_object('kn_reservation', r ->> 'reservation')) returning id into v;
  r := public.register_invite_finish(p_code, (r ->> 'reservation')::uuid, v);
  if r ->> 'result' <> 'done' then raise exception 'finish: %', r; end if;
  return v;
end $$;

-- ===== состояние «как в production сейчас» (до v61): окно F&F закрыто 24.10 =====
update private.ai_limits set beta_starts_at = '2026-10-18 21:00+00', beta_ends_at = '2026-10-23 21:00+00',
  max_total_starts = 40, total_starts = 7, max_in_flight = 1, max_user_starts = 3 where id;
create table t.acc (n int, uid uuid);
do $$
declare i int; v uuid; n uuid;
begin
  for i in 1..7 loop   -- участники F&F (2 из них потратили генерацию)
    insert into auth.users (email, raw_app_meta_data) values (private.kn_email('KN-F' || translate(lpad(i::text, 5, '0'), '0123456789', 'ABCDEFGHJK')),
      jsonb_build_object('kn_reservation', gen_random_uuid())) returning id into v;
    insert into private.user_entitlements (user_id, resource, plan, quota, source) values (v, 'text_generation', 'beta', 1, 'beta_invite');
    insert into t.acc values (i, v);
    if i in (5, 6) then
      n := t.note(v);
      insert into private.usage_ledger (user_id, resource, op_key, note_id, state, reserved_at, expires_at, finalized_at)
      values (v, 'text_generation', n::text, n, 'consumed', now() - interval '3 days', now() - interval '3 days' + interval '10 minutes', now() - interval '3 days');
      update public.notes set status = 'ready', stage = 'done' where id = n;
    end if;
  end loop;
  for i in 1..2 loop   -- анонимные служебные аккаунты владельца
    insert into auth.users (is_anonymous) values (true) returning id into v;
    insert into private.user_entitlements (user_id, resource, plan, quota, source) values (v, 'text_generation', 'beta', 100, 'manual');
    insert into t.acc values (100 + i, v);
  end loop;
  for i in 1..3 loop insert into auth.users (is_anonymous) values (true) returning id into v; insert into t.acc values (200 + i, v); end loop;
end $$;

-- ===== новый ученик, приглашённый ДО выпуска через v59 =====
select t.register('V59NEWCODE01', 'KN-NEWAAA') as un \gset
insert into t.acc values (300, :'un');
select t.note(:'un') as nn \gset
update public.notes set status = 'ready', stage = 'done', title = 'Личный конспект', content = '{}'::jsonb where id = :'nn';
select t.ok('V1. v59-регистрация после 24.10: аккаунт создан, право beta_invite (как у F&F)',
  exists (select 1 from private.user_entitlements where user_id = :'un' and source = 'beta_invite' and quota = 1));
select t.ok('V2. v59: ИИ недоступен — окно F&F закрыто (get_my_access: остаток 0)', (t.me_old(:'un') -> 0 ->> 'remaining')::int = 0);
select t.ok('V3. v59: генерация отклоняется сервером (access_expired)', t.start_old(:'un', t.note(:'un')) = 'access_expired');

create table t.before as select a.n, t.me_old(a.uid) a from t.acc a;
create table t.ledger_before as select * from private.usage_ledger;
create table t.notes_before as select * from public.notes;

-- ===== шаг 1 выпуска: миграция =====
\i :mig

select t.ok('C1. миграция не создала ни одной выдачи доступа', (select count(*) from private.access_grants) = 0);
select t.ok('C2. старый get_my_access (v59) отвечает всем 13 аккаунтам так же, как до миграции',
  (select bool_and(b.a = t.me_old(a.uid)) from t.before b join t.acc a using (n)));
select t.ok('C3. журнал генераций не изменён', (select count(*) from t.ledger_before) = (select count(*) from private.usage_ledger)
  and not exists (select 1 from t.ledger_before b join private.usage_ledger l using (id) where (b.state, b.attempts) is distinct from (l.state, l.attempts)));
select t.ok('C4. конспекты не изменены', (select count(*) from t.notes_before) = (select count(*) from public.notes)
  and not exists (select 1 from t.notes_before b join public.notes n using (id) where (b.status, b.title, b.content) is distinct from (n.status, n.title, n.content)));
select t.ok('C5. F&F: expired/legacy; права не изменились', (select bool_and(t.me(uid) ->> 'status' = 'expired' and t.me(uid) ->> 'kind' = 'legacy') from t.acc where n <= 7)
  and (select count(*) from private.user_entitlements where source = 'beta_invite' and quota = 1) = 8);
select t.ok('C6. служебные анонимные: legacy paid; генерация идёт (старый и новый путь)',
  (select bool_and(t.me(uid) ->> 'status' = 'paid') from t.acc where n between 101 and 102)
  and t.start_old((select uid from t.acc where n = 101), t.note((select uid from t.acc where n = 101))) = 'started');
update private.usage_ledger set state = 'released', finalized_at = now() where state = 'reserved';
select t.ok('C7. гости без прав: none', (select bool_and(t.me(uid) ->> 'status' = 'none') from t.acc where n > 200 and n < 300));

-- ученик, приглашённый до выпуска
select t.ok('V4. после миграции: v59-ученик — expired/legacy, пробный автоматически не выдан, конспект на месте',
  t.me(:'un') ->> 'status' = 'expired' and not exists (select 1 from private.access_grants where user_id = :'un')
  and exists (select 1 from public.notes where id = :'nn' and title = 'Личный конспект'));
select private.admin_grant_trial('KN-NEWAAA', 'приглашён до v61') ->> 'result' as tr \gset
select t.ok('V5. вариант «пробный при выпуске»: admin_grant_trial — 7 дней, 1 генерация', :'tr' = 'trial_granted'
  and t.me(:'un') ->> 'status' = 'trial' and (t.me(:'un') ->> 'ai_quota')::int = 1);
select t.note(:'un') as nv \gset
select t.ok('V6. v59-ученик после выдачи пробного — генерация started (новая analyze-pages)', t.start(:'un', :'nv') = 'started');
select t.finish(:'nv', true);
select t.ok('V7. второй пробный этому ученику не выдаётся', private.admin_grant_trial('KN-NEWAAA') ->> 'result' = 'trial_already_used');

-- окно между шагами 1 и 2/3: ученик, зарегистрированный ПОСЛЕ миграции
select t.register('WINDOWCODE01', 'KN-WNDAAA') as uw \gset
select t.ok('W1. регистрация после миграции — пробный период выдан автоматически', t.me(:'uw') ->> 'status' = 'trial');
select t.note(:'uw') as wn \gset
select t.ok('W2. (окно выпуска) старая analyze-pages v24 ему отказывает — поэтому выпуск одним окном', t.start_old(:'uw', :'wn') = 'access_expired');
select t.ok('W3. (окно выпуска) старый клиент v59 показывает остаток 0', (t.me_old(:'uw') -> 0 ->> 'remaining')::int = 0);
select t.ok('W4. после шага 2 — генерация работает', t.start(:'uw', :'wn') = 'started');
select t.finish(:'wn', true);

-- ===== откат миграции (блок из файла) =====
create table t.ledger_mid as select id, state, attempts from private.usage_ledger;
begin;
drop trigger notes_finish_generation_start on public.notes;
drop trigger user_entitlements_trial on private.user_entitlements;
drop function public.start_text_generation_v2(uuid, uuid, integer, integer, integer);
drop function public.get_my_access_v2();
drop function public.get_plans();
drop function private.admin_grant_trial(text, text);
drop function private.admin_set_owner(text, text);
drop function private.admin_revoke(text, text, text, text);
drop function private.admin_extend(text, text, integer, integer, text, text);
drop function private.admin_grant(text, text, integer, integer, text, text);
drop function private.admin_status(text);
drop function private.admin_terms(text, integer, integer);
drop function private.admin_lock(uuid);
drop function private.admin_user(text);
drop function private.grant_trial_on_register();
drop function private.finish_generation_start();
drop function private.failed_starts(uuid, timestamptz, uuid, interval);
drop function private.access_state(uuid);
drop function private.grant_usage(uuid, text);
drop function private.active_grant(uuid, timestamptz);
alter table private.usage_ledger drop column grant_id;
drop table private.generation_starts;
drop table private.access_log;
drop table private.access_grants;
drop table private.plans;
drop table private.access_settings;
commit;
select t.ok('RB1. откат без ошибок; журнал генераций сохранён', (select count(*) from t.ledger_mid) = (select count(*) from private.usage_ledger)
  and not exists (select 1 from t.ledger_mid m join private.usage_ledger l using (id) where (m.state, m.attempts) is distinct from (l.state, l.attempts)));
select t.ok('RB2. после отката v59 работает: служебный аккаунт — started; конспекты на месте',
  t.start_old((select uid from t.acc where n = 102), t.note((select uid from t.acc where n = 102))) = 'started'
  and exists (select 1 from public.notes where id = :'nn'));
select t.ok('RB3. после отката не осталось объектов v61', to_regclass('private.access_grants') is null and to_regclass('private.generation_starts') is null
  and not exists (select 1 from pg_trigger where tgname in ('notes_finish_generation_start', 'user_entitlements_trial')));

select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok and info is not null then ' → ' || info else '' end from t.results order by n;
select 'ИТОГО: ' || count(*) filter (where ok) || ' PASS, ' || count(*) filter (where not ok) || ' FAIL' from t.results;
