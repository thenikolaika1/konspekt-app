-- =====================================================================================
-- Konspekt v61.3: панель владельца (внутри приложения) — постоянный пароль панели и защищённые функции.
--
-- Применять ПОСЛЕ 20261024150000_paid_access.sql, одним запуском (весь файл — одна транзакция).
-- Только добавляет объекты; существующие строки (аккаунты, выдачи, приглашения, журнал, лимиты AI) не меняются.
-- Единственные изменения существующих объектов: значение по умолчанию access_log.actor (кто действовал — панель
-- или SQL Editor) и триггер на private.beta_invites (служебная строка для каждого кода — для отзыва и списка).
--
-- Доступ к панели — только при всех четырёх условиях одновременно, всё проверяет сервер:
--   1) действующий вход Supabase Auth (JWT) аккаунта с ID (не гость) и его сессия входа ещё существует;
--   2) действующая выдача «владелец» (private.access_grants, kind = owner);
--   3) верный постоянный пароль панели (хранится только bcrypt-отпечаток, pgcrypto crypt/gen_salt('bf'));
--   4) действующая сессия панели: случайный ключ 256 бит, в базе — только его sha256; срок 12 часов,
--      без действий 2 часа; привязана к аккаунту, к сессии входа и к версии пароля.
-- Перебор: 5 неверных попыток подряд — пауза 15 минут, дальше 1 час, 4 часа, 24 часа; попытки одного владельца
-- строго по очереди (блокировка строки), счётчик на сервере — перезагрузка страницы его не сбрасывает.
-- Первый пароль и сброс забытого — только через SQL Editor (private.admin_panel_setup → одноразовый код на 30 минут),
-- сам пароль вводится уже в приложении владельцем и в SQL/логи не попадает.
--
-- Браузеру (authenticated) — только public.owner_* (SECURITY DEFINER, search_path = ''); каждая функция начинает
-- с проверки условий 1–4. Закрытые таблицы по-прежнему недоступны ролям API. service_role не нужен.
-- Порядок блокировок: владелец (строка owner_panel_secrets / advisory пользователя) → как в функциях admin_*.
-- Откат — в конце файла.
-- =====================================================================================

begin;

do $$
begin
  if to_regclass('private.access_grants') is null then
    raise exception 'Сначала примените 20261024150000_paid_access.sql';
  end if;
  if to_regprocedure('extensions.crypt(text,text)') is null or to_regprocedure('extensions.gen_random_bytes(integer)') is null then
    raise exception 'Нужен pgcrypto в схеме extensions (в Supabase установлен по умолчанию)';
  end if;
end $$;

-- -------------------------------------------------------------------------------------
-- 1. Таблицы (схема private: ролям API недоступна)
-- -------------------------------------------------------------------------------------

-- Пароль панели владельца: только bcrypt-отпечаток. setup_hash — sha256 одноразового кода установки/сброса.
create table private.owner_panel_secrets (
  user_id          uuid        primary key references auth.users (id) on delete cascade,
  password_hash    text        check (password_hash is null or password_hash like '$2%'),
  password_version integer     not null default 0,
  password_set_at  timestamptz,
  setup_hash       text        check (setup_hash is null or setup_hash ~ '^[0-9a-f]{64}$'),
  setup_expires_at timestamptz,
  failed_count     integer     not null default 0 check (failed_count >= 0),
  lock_level       integer     not null default 0 check (lock_level between 0 and 10),
  locked_until     timestamptz,
  updated_at       timestamptz not null default now()
);

-- Сессии панели: ключ на руках у браузера владельца, здесь — только sha256.
create table private.owner_panel_sessions (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users (id) on delete cascade,
  token_hash       text        not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  auth_session_id  uuid,
  password_version integer     not null,
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz
);
create index owner_panel_sessions_user on private.owner_panel_sessions (user_id) where revoked_at is null;

-- Журнал безопасности панели: входы, неверные пароли, паузы, смена и сброс пароля (без самих паролей и кодов).
create table private.owner_security_log (
  id      bigint      generated always as identity primary key,
  at      timestamptz not null default now(),
  user_id uuid,
  event   text        not null,
  details jsonb       not null default '{}'::jsonb
);
create index owner_security_log_user on private.owner_security_log (user_id, at);

-- Идемпотентность действий панели: повтор с тем же request_id возвращает прежний результат, а не повторяет действие.
create table private.owner_requests (
  request_id uuid        primary key,
  user_id    uuid        not null,
  action     text        not null,
  args       jsonb       not null,
  result     jsonb,
  created_at timestamptz not null default now()
);

-- Служебные данные кода приглашения (сам код и его отпечаток наружу не отдаются; id — для списка и отзыва).
create table private.invite_meta (
  code_hash  text        primary key references private.beta_invites (code_hash) on delete cascade,
  id         uuid        not null unique default gen_random_uuid(),
  source     text        not null default 'script' check (source in ('script', 'panel')),
  created_by uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index invite_meta_panel_time on private.invite_meta (created_at) where source = 'panel';
insert into private.invite_meta (code_hash, created_at) select i.code_hash, i.created_at from private.beta_invites i;

alter table private.owner_panel_secrets  enable row level security;
alter table private.owner_panel_sessions enable row level security;
alter table private.owner_security_log   enable row level security;
alter table private.owner_requests       enable row level security;
alter table private.invite_meta          enable row level security;
revoke all on private.owner_panel_secrets, private.owner_panel_sessions, private.owner_security_log,
              private.owner_requests, private.invite_meta
  from public, anon, authenticated, service_role;

-- Кто действовал: панель выставляет konspekt.actor = panel:KN-… на время своей транзакции; иначе — как раньше.
alter table private.access_log
  alter column actor set default coalesce(nullif(pg_catalog.current_setting('konspekt.actor', true), ''), session_user);

-- -------------------------------------------------------------------------------------
-- 2. Внутренние функции
-- -------------------------------------------------------------------------------------

-- Случайная строка из алфавита (без похожих символов) без смещения: байт берётся, только если < длина·⌊256/длина⌋.
create function private.panel_random(p_len integer, p_alphabet text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_n   integer := pg_catalog.length(p_alphabet);
  v_max integer := v_n * (256 / v_n);
  v_b   bytea;
  v_s   text := '';
  i     integer;
begin
  while pg_catalog.length(v_s) < p_len loop
    v_b := extensions.gen_random_bytes(64);
    for i in 0..63 loop
      if pg_catalog.get_byte(v_b, i) < v_max and pg_catalog.length(v_s) < p_len then
        v_s := v_s || pg_catalog.substr(p_alphabet, pg_catalog.get_byte(v_b, i) % v_n + 1, 1);
      end if;
    end loop;
  end loop;
  return v_s;
end
$$;

-- Пароль панели и код установки: 20 / 12 символов алфавита ID (31 символ, без 0/O/1/I/L), дефисы и регистр не важны.
create function private.panel_normalize(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_value, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

create function private.panel_sha256(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_value, 'UTF8')), 'hex')
$$;

create function private.panel_log(p_user_id uuid, p_event text, p_details jsonb default '{}'::jsonb)
returns void
language sql
volatile
set search_path = ''
as $$
  insert into private.owner_security_log (user_id, event, details) values (p_user_id, p_event, coalesce(p_details, '{}'::jsonb))
$$;

-- ID участника по аккаунту (технический адрес id-kn-xxxxxx@id.konspekt.invalid → KN-XXXXXX); не ID — NULL.
create function private.panel_kn(p_user_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.upper(pg_catalog.substr(pg_catalog.split_part(u.email, '@', 1), 4))
    from auth.users u
   where u.id = p_user_id and not u.is_anonymous and u.email like 'id-kn-%@id.konspekt.invalid'
$$;

-- Условия 1–2: вошедший аккаунт с ID, сессия входа жива, действующая выдача «владелец». Иначе NULL.
create function private.panel_owner_uid()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid;
begin
  if v_uid is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    return null;
  end if;
  if private.panel_kn(v_uid) is null then
    return null;
  end if;
  -- выход из аккаунта удаляет сессию входа: её JWT ещё действует до часа, но панель — уже нет
  v_sid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  if v_sid is null or not exists (select 1 from auth.sessions s where s.id = v_sid and s.user_id = v_uid) then
    return null;
  end if;
  if not exists (select 1 from private.access_grants g
                  where g.user_id = v_uid and g.kind = 'owner' and g.revoked_at is null
                    and g.starts_at <= pg_catalog.now() and (g.ends_at is null or g.ends_at > pg_catalog.now())) then
    return null;
  end if;
  return v_uid;
end
$$;

-- Новая сессия панели для владельца; возвращает ключ (только здесь и только один раз).
create function private.panel_new_session(p_user_id uuid)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_token text := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  v_exp   timestamptz := pg_catalog.now() + interval '12 hours';
begin
  insert into private.owner_panel_sessions (user_id, token_hash, auth_session_id, password_version, expires_at)
  select p_user_id, private.panel_sha256(v_token), nullif(auth.jwt() ->> 'session_id', '')::uuid, s.password_version, v_exp
    from private.owner_panel_secrets s where s.user_id = p_user_id;
  return jsonb_build_object('session', v_token, 'expires_at', v_exp, 'idle_minutes', 120);
end
$$;

-- Условия 1–4 для каждой функции панели. o_err: FORBIDDEN (не владелец / нет входа) | PANEL_LOCKED (нужен пароль).
create function private.panel_check(p_session text, out o_uid uuid, out o_kn text, out o_err text)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid uuid := private.panel_owner_uid();
  v_id  uuid;
begin
  if v_uid is null then
    o_err := 'FORBIDDEN';
    return;
  end if;
  select ps.id into v_id
    from private.owner_panel_sessions ps
    join private.owner_panel_secrets s on s.user_id = ps.user_id
   where ps.token_hash = private.panel_sha256(coalesce(p_session, ''))
     and ps.user_id = v_uid
     and ps.revoked_at is null
     and ps.expires_at > pg_catalog.now()
     and ps.last_used_at > pg_catalog.now() - interval '2 hours'
     and ps.password_version = s.password_version
     and s.password_hash is not null
     and ps.auth_session_id is not distinct from nullif(auth.jwt() ->> 'session_id', '')::uuid;
  if v_id is null then
    o_err := 'PANEL_LOCKED';
    return;
  end if;
  update private.owner_panel_sessions set last_used_at = pg_catalog.now() where id = v_id;
  o_uid := v_uid;
  o_kn := private.panel_kn(v_uid);
  -- кто действовал — для access_log (значение по умолчанию actor), только до конца этой транзакции
  perform pg_catalog.set_config('konspekt.actor', 'panel:' || o_kn, true);
end
$$;

-- Пауза после серии неверных попыток: 15 минут, 1 час, 4 часа, дальше 24 часа.
create function private.panel_lock_interval(p_level integer)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case when p_level <= 1 then interval '15 minutes' when p_level = 2 then interval '1 hour'
              when p_level = 3 then interval '4 hours' else interval '24 hours' end
$$;

-- Неверная попытка (пароль или код установки): счётчик, пауза, журнал. Вызывается под блокировкой строки секрета.
create function private.panel_failed_attempt(p_user_id uuid, p_what text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_s private.owner_panel_secrets;
begin
  update private.owner_panel_secrets s
     set failed_count = s.failed_count + 1, updated_at = pg_catalog.now()
   where s.user_id = p_user_id
  returning * into v_s;
  perform private.panel_log(p_user_id, 'unlock_failed', jsonb_build_object('what', p_what, 'in_row', v_s.failed_count));
  if v_s.failed_count >= 5 then
    update private.owner_panel_secrets s
       set failed_count = 0, lock_level = least(s.lock_level + 1, 10),
           locked_until = pg_catalog.now() + private.panel_lock_interval(s.lock_level + 1), updated_at = pg_catalog.now()
     where s.user_id = p_user_id
    returning * into v_s;
    perform private.panel_log(p_user_id, 'locked', jsonb_build_object('until', v_s.locked_until, 'level', v_s.lock_level));
    return jsonb_build_object('result', 'locked', 'locked_until', v_s.locked_until);
  end if;
  return jsonb_build_object('result', 'wrong');
end
$$;

-- Установка пароля (новый bcrypt-отпечаток, новая версия: все прежние сессии недействительны).
create function private.panel_store_password(p_user_id uuid, p_password text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_pw  text := private.panel_normalize(p_password);
  v_enc text;
begin
  if v_pw !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{20}$' then
    return jsonb_build_object('result', 'weak_password');
  end if;
  -- пароль панели не должен совпадать с ключом аккаунта (пароль входа = 'Kn-2.' || ключ, js/cloud.js)
  select u.encrypted_password into v_enc from auth.users u where u.id = p_user_id;
  if v_enc like '$2%' and extensions.crypt('Kn-2.' || v_pw, v_enc) = v_enc then
    return jsonb_build_object('result', 'same_as_key');
  end if;
  update private.owner_panel_secrets s
     set password_hash = extensions.crypt(v_pw, extensions.gen_salt('bf', 12)),
         password_version = s.password_version + 1, password_set_at = pg_catalog.now(),
         setup_hash = null, setup_expires_at = null, failed_count = 0, lock_level = 0, locked_until = null,
         updated_at = pg_catalog.now()
   where s.user_id = p_user_id;
  update private.owner_panel_sessions ps set revoked_at = pg_catalog.now()
   where ps.user_id = p_user_id and ps.revoked_at is null;
  return null;
end
$$;

-- Начало идемпотентного действия: NULL — выполнять; иначе — сохранённый результат прежнего запроса.
create function private.panel_request(p_request_id uuid, p_user_id uuid, p_action text, p_args jsonb)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_r private.owner_requests;
begin
  if p_request_id is null then
    return jsonb_build_object('error', 'INVALID_INPUT', 'message', 'Нет идентификатора операции');
  end if;
  insert into private.owner_requests (request_id, user_id, action, args)
  values (p_request_id, p_user_id, p_action, p_args)
  on conflict (request_id) do nothing;
  if found then
    return null;
  end if;
  -- тот же request_id уже был: параллельный запрос дождался первого (уникальный ключ) и видит его итог
  select * into v_r from private.owner_requests r where r.request_id = p_request_id;
  if v_r.user_id <> p_user_id or v_r.action <> p_action or v_r.args <> p_args then
    return jsonb_build_object('error', 'REQUEST_REUSED');
  end if;
  return coalesce(v_r.result, jsonb_build_object('error', 'SERVER_ERROR')) || jsonb_build_object('replayed', true);
end
$$;

create function private.panel_request_done(p_request_id uuid, p_result jsonb)
returns jsonb
language sql
volatile
set search_path = ''
as $$
  update private.owner_requests set result = p_result - 'code' where request_id = p_request_id;
  select p_result
$$;

-- Действующий/будущий оплаченный доступ ученика (что увидит владелец перед продлением и отзывом).
create function private.panel_paid_periods(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('starts_at', g.starts_at, 'ends_at', g.ends_at, 'ai_quota', g.ai_quota,
                                               'ai_used', u.used, 'plan', g.plan) order by g.starts_at), '[]'::jsonb)
    from private.access_grants g cross join lateral private.grant_usage(g.id) u
   where g.user_id = p_user_id and g.kind = 'paid' and g.revoked_at is null and g.ends_at > pg_catalog.now()
$$;

-- Код ученика из ввода владельца: KN-XXXXXX или NULL (неверный формат).
create function private.panel_kn_input(p_kn_id text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when x ~ '^KN[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$' then 'KN-' || pg_catalog.substr(x, 3)
              when x ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$' then 'KN-' || x end
    from (select private.panel_normalize(p_kn_id) x) s
$$;

create function private.panel_user_by_kn(p_kn text)
returns uuid
language sql
stable
set search_path = ''
as $$
  select u.id from auth.users u where u.email = private.kn_email(p_kn) and not u.is_anonymous
$$;

-- Статус приглашения для списка: used | revoked | expired | active.
create function private.panel_invite_status(p_redeemed_at timestamptz, p_revoked_at timestamptz, p_expires_at timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case when p_redeemed_at is not null then 'used' when p_revoked_at is not null then 'revoked'
              when p_expires_at is not null and p_expires_at <= pg_catalog.now() then 'expired' else 'active' end
$$;

-- Каждый новый код (скрипт tools/ff-invite-codes.mjs или панель) получает служебную строку.
create function private.invite_meta_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.invite_meta (code_hash, source, created_by)
  values (new.code_hash, coalesce(nullif(pg_catalog.current_setting('konspekt.invite_source', true), ''), 'script'),
          nullif(pg_catalog.current_setting('konspekt.invite_by', true), '')::uuid)
  on conflict (code_hash) do nothing;
  return null;
end
$$;
create trigger beta_invites_meta after insert on private.beta_invites
  for each row execute function private.invite_meta_on_insert();

-- -------------------------------------------------------------------------------------
-- 3. Владелец в SQL Editor: первый пароль и сброс забытого (доверенная процедура)
-- -------------------------------------------------------------------------------------

-- Одноразовый код установки пароля панели (30 минут). Если пароль уже был — это сброс: пароль удаляется, все
-- сессии панели закрываются. Код действует только в приложении из аккаунта этого владельца.
create function private.admin_panel_setup(p_kn_id text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid   uuid := private.admin_user(p_kn_id);
  v_code  text := private.panel_random(12, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789');
  v_reset boolean;
begin
  if not exists (select 1 from private.access_grants g where g.user_id = v_uid and g.kind = 'owner' and g.revoked_at is null) then
    raise exception 'Участник % — не владелец: сначала private.admin_set_owner', p_kn_id using errcode = '22023';
  end if;
  insert into private.owner_panel_secrets (user_id) values (v_uid) on conflict (user_id) do nothing;
  select password_hash is not null into v_reset from private.owner_panel_secrets where user_id = v_uid for update;
  update private.owner_panel_secrets s
     set password_hash = null, password_version = s.password_version + 1,
         setup_hash = private.panel_sha256(v_code), setup_expires_at = pg_catalog.now() + interval '30 minutes',
         failed_count = 0, lock_level = 0, locked_until = null, updated_at = pg_catalog.now()
   where s.user_id = v_uid;
  update private.owner_panel_sessions ps set revoked_at = pg_catalog.now() where ps.user_id = v_uid and ps.revoked_at is null;
  perform private.panel_log(v_uid, case when v_reset then 'password_reset' else 'setup_code_issued' end, '{}'::jsonb);
  return jsonb_build_object('result', case when v_reset then 'reset' else 'setup' end,
    'setup_code', pg_catalog.substr(v_code, 1, 4) || '-' || pg_catalog.substr(v_code, 5, 4) || '-' || pg_catalog.substr(v_code, 9, 4),
    'expires_at', pg_catalog.now() + interval '30 minutes',
    'next', 'Приложение → Я → Панель владельца → «Установить пароль» → этот код');
end
$$;

-- Закрыть все сессии панели владельца (например, потерян телефон), пароль не меняется.
create function private.admin_panel_revoke_sessions(p_kn_id text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid uuid := private.admin_user(p_kn_id);
  v_n   integer;
begin
  update private.owner_panel_sessions ps set revoked_at = pg_catalog.now() where ps.user_id = v_uid and ps.revoked_at is null;
  get diagnostics v_n = row_count;
  perform private.panel_log(v_uid, 'sessions_revoked', jsonb_build_object('by', 'sql_editor', 'count', v_n));
  return jsonb_build_object('result', 'revoked', 'sessions', v_n);
end
$$;

-- -------------------------------------------------------------------------------------
-- 4. Вход в панель (приложение, authenticated)
-- -------------------------------------------------------------------------------------

-- Что показать на кнопке панели: не владелец — только owner=false (ничего лишнего).
create function public.owner_panel_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.panel_owner_uid();
  v_s   private.owner_panel_secrets;
begin
  if v_uid is null then
    return jsonb_build_object('owner', false);
  end if;
  select * into v_s from private.owner_panel_secrets s where s.user_id = v_uid;
  return jsonb_build_object(
    'owner', true,
    'kn_id', private.panel_kn(v_uid),
    'password_set', v_s.password_hash is not null,
    'setup_pending', v_s.setup_hash is not null and v_s.setup_expires_at > pg_catalog.now(),
    'locked_until', case when v_s.locked_until > pg_catalog.now() then v_s.locked_until end,
    'session_hours', 12, 'idle_minutes', 120);
end
$$;

-- Первый пароль (или новый после сброса) по одноразовому коду из SQL Editor.
create function public.owner_panel_setup(p_setup_code text, p_new_password text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.panel_owner_uid();
  v_s   private.owner_panel_secrets;
  v_r   jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('error', 'FORBIDDEN');
  end if;
  select * into v_s from private.owner_panel_secrets s where s.user_id = v_uid for update;
  if not found or v_s.setup_hash is null or v_s.setup_expires_at <= pg_catalog.now() then
    return jsonb_build_object('error', 'NO_SETUP_CODE');
  end if;
  if v_s.locked_until > pg_catalog.now() then
    return jsonb_build_object('error', 'LOCKED', 'locked_until', v_s.locked_until);
  end if;
  if private.panel_sha256(private.panel_normalize(p_setup_code)) <> v_s.setup_hash then
    v_r := private.panel_failed_attempt(v_uid, 'setup_code');
    return jsonb_build_object('error', case when v_r ->> 'result' = 'locked' then 'LOCKED' else 'WRONG_CODE' end,
                              'locked_until', v_r -> 'locked_until');
  end if;
  v_r := private.panel_store_password(v_uid, p_new_password);
  if v_r is not null then
    return jsonb_build_object('error', pg_catalog.upper(v_r ->> 'result'));
  end if;
  perform private.panel_log(v_uid, 'password_set', '{}'::jsonb);
  return jsonb_build_object('result', 'ok') || private.panel_new_session(v_uid);
end
$$;

-- Вход в панель постоянным паролем.
create function public.owner_unlock(p_password text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.panel_owner_uid();
  v_s   private.owner_panel_secrets;
  v_r   jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('error', 'FORBIDDEN');
  end if;
  -- попытки одного владельца — строго по очереди: параллельные запросы ждут здесь и видят обновлённый счётчик
  select * into v_s from private.owner_panel_secrets s where s.user_id = v_uid for update;
  if not found or v_s.password_hash is null then
    return jsonb_build_object('error', 'NOT_SET');
  end if;
  if v_s.locked_until > pg_catalog.now() then
    return jsonb_build_object('error', 'LOCKED', 'locked_until', v_s.locked_until);
  end if;
  if extensions.crypt(private.panel_normalize(p_password), v_s.password_hash) <> v_s.password_hash then
    v_r := private.panel_failed_attempt(v_uid, 'password');
    return jsonb_build_object('error', case when v_r ->> 'result' = 'locked' then 'LOCKED' else 'WRONG_PASSWORD' end,
                              'locked_until', v_r -> 'locked_until');
  end if;
  update private.owner_panel_secrets s set failed_count = 0, lock_level = 0, locked_until = null, updated_at = pg_catalog.now()
   where s.user_id = v_uid;
  perform private.panel_log(v_uid, 'unlocked', '{}'::jsonb);
  return jsonb_build_object('result', 'ok') || private.panel_new_session(v_uid);
end
$$;

-- Выйти из панели на этом устройстве (ключ сессии становится недействительным). Ответ одинаковый всегда.
create function public.owner_lock(p_session text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is not null then
    update private.owner_panel_sessions ps set revoked_at = pg_catalog.now()
     where ps.user_id = v_uid and ps.token_hash = private.panel_sha256(coalesce(p_session, '')) and ps.revoked_at is null;
  end if;
  return jsonb_build_object('result', 'ok');
end
$$;

-- Выйти из панели на всех устройствах.
create function public.owner_lock_all(p_session text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c record;
  v_n integer;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  update private.owner_panel_sessions ps set revoked_at = pg_catalog.now() where ps.user_id = v_c.o_uid and ps.revoked_at is null;
  get diagnostics v_n = row_count;
  perform private.panel_log(v_c.o_uid, 'sessions_revoked', jsonb_build_object('by', 'panel', 'count', v_n));
  return jsonb_build_object('result', 'ok', 'sessions', v_n);
end
$$;

-- Смена пароля: нужен текущий; все сессии закрываются, это устройство получает новую.
create function public.owner_change_password(p_session text, p_current_password text, p_new_password text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c record;
  v_s private.owner_panel_secrets;
  v_r jsonb;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  select * into v_s from private.owner_panel_secrets s where s.user_id = v_c.o_uid for update;
  if v_s.locked_until > pg_catalog.now() then
    return jsonb_build_object('error', 'LOCKED', 'locked_until', v_s.locked_until);
  end if;
  if extensions.crypt(private.panel_normalize(p_current_password), v_s.password_hash) <> v_s.password_hash then
    v_r := private.panel_failed_attempt(v_c.o_uid, 'change_password');
    return jsonb_build_object('error', case when v_r ->> 'result' = 'locked' then 'LOCKED' else 'WRONG_PASSWORD' end,
                              'locked_until', v_r -> 'locked_until');
  end if;
  if private.panel_normalize(p_new_password) = private.panel_normalize(p_current_password) then
    return jsonb_build_object('error', 'SAME_PASSWORD');
  end if;
  v_r := private.panel_store_password(v_c.o_uid, p_new_password);
  if v_r is not null then
    return jsonb_build_object('error', pg_catalog.upper(v_r ->> 'result'));
  end if;
  perform private.panel_log(v_c.o_uid, 'password_changed', '{}'::jsonb);
  return jsonb_build_object('result', 'ok') || private.panel_new_session(v_c.o_uid);
end
$$;

-- -------------------------------------------------------------------------------------
-- 5. Данные панели (только чтение)
-- -------------------------------------------------------------------------------------

-- Состояние AI для панели: бюджет, автостоп (как private.ai_breaker), его причина и время снятия «не позже»
-- (если новых сбоев не будет), технические ошибки, запуски за 7 дней.
create function private.panel_ai_state()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_l    record;
  v_c    private.access_settings;
  v_now  timestamptz := pg_catalog.now();
  v_w    timestamptz;
  v_win  integer;
  v_wu   integer;
  v_day  integer;
  v_wact boolean;
  v_dact boolean;
  v_wend timestamptz;
  v_dend timestamptz;
  v_aw   timestamptz[];
  v_ad   timestamptz[];
  v_res  jsonb;
begin
  select * into v_l from private.ai_limits limit 1;
  select * into v_c from private.access_settings limit 1;
  v_w := v_now - pg_catalog.make_interval(mins => v_c.breaker_minutes);
  -- технические неудачи за сутки — как в private.ai_breaker
  select count(*) filter (where f.started_at >= v_w), count(distinct f.user_id) filter (where f.started_at >= v_w), count(*),
         pg_catalog.array_agg(f.started_at order by f.started_at) filter (where f.started_at >= v_w),
         pg_catalog.array_agg(f.started_at order by f.started_at)
    into v_win, v_wu, v_day, v_aw, v_ad
    from private.generation_starts f
   where f.started_at >= v_now - interval '24 hours'
     and ((f.outcome = 'failed' and private.failure_kind(f.error_code) = 'tech')
          or (f.outcome is null and f.started_at < v_now - interval '10 minutes'));
  v_wact := v_win >= v_c.breaker_errors and v_wu >= 2;
  v_dact := v_day >= v_c.breaker_errors_per_day;
  -- когда неудач в окне станет меньше предела, если новых не будет (условие «2 пользователя» может снять раньше)
  if v_wact then
    v_wend := v_aw[v_win - v_c.breaker_errors + 1] + pg_catalog.make_interval(mins => v_c.breaker_minutes);
  end if;
  if v_dact then
    v_dend := v_ad[v_day - v_c.breaker_errors_per_day + 1] + interval '24 hours';
  end if;
  v_res := jsonb_build_object(
    'budget', v_l.max_total_starts,
    'used', v_l.total_starts,
    'remaining', greatest(v_l.max_total_starts - v_l.total_starts, 0),
    'ai_enabled', v_l.ai_enabled,
    'max_in_flight', v_l.max_in_flight,
    'in_flight', (select count(*) from private.usage_ledger l where l.state = 'reserved' and l.expires_at > v_now),
    'state', case when not v_l.ai_enabled then 'disabled'
                  when v_l.total_starts >= v_l.max_total_starts then 'budget_exhausted'
                  when v_wact or v_dact then 'breaker' else 'ok' end,
    'breaker', jsonb_build_object(
      'active', v_wact or v_dact,
      'reason', case when v_dact then 'daily' when v_wact then 'mass' end,
      'until_at_most', case when v_wact or v_dact then greatest(v_wend, v_dend) end,
      'window_errors', v_win, 'window_users', v_wu, 'window_minutes', v_c.breaker_minutes, 'window_limit', v_c.breaker_errors,
      'day_errors', v_day, 'day_limit', v_c.breaker_errors_per_day),
    'tech_errors_24h', v_day,
    'user_errors_24h', private.failed_starts(null, v_now - interval '24 hours', 'user'),
    'starts_24h', (select count(*) from private.generation_starts s where s.started_at >= v_now - interval '24 hours'),
    'ok_24h', (select count(*) from private.generation_starts s where s.started_at >= v_now - interval '24 hours' and s.outcome = 'ok'),
    'limits', jsonb_build_object('tech_pause_after', v_c.tech_pause_after, 'tech_pause_minutes', v_c.tech_pause_minutes,
                                 'max_tech_errors_per_day', v_c.max_tech_errors_per_day, 'max_user_errors_per_day', v_c.max_user_errors_per_day,
                                 'max_starts_per_day', v_c.max_starts_per_day),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'starts', coalesce(x.starts, 0), 'ok', coalesce(x.ok, 0),
                                                         'failed', coalesce(x.failed, 0)) order by d.day), '[]'::jsonb)
               from (select (pg_catalog.timezone('Europe/Moscow', v_now))::date - g as day from pg_catalog.generate_series(0, 6) g) d
               left join (select (pg_catalog.timezone('Europe/Moscow', s.started_at))::date as day, count(*) as starts,
                                 count(*) filter (where s.outcome = 'ok') as ok, count(*) filter (where s.outcome = 'failed') as failed
                            from private.generation_starts s where s.started_at >= v_now - interval '8 days' group by 1) x on x.day = d.day),
    'server_now', v_now);
  return v_res;
end
$$;

-- Ученики с ID (без гостей): ID, состояние доступа (с сервера), регистрация, последняя генерация.
create function private.panel_students()
returns table (user_id uuid, kn_id text, registered_at timestamptz, access jsonb, last_generation_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select u.id, private.panel_kn(u.id), u.created_at, private.access_state(u.id),
         (select max(s.started_at) from private.generation_starts s where s.user_id = u.id)
    from auth.users u
   where not u.is_anonymous and u.email like 'id-kn-%@id.konspekt.invalid'
$$;

create function private.panel_student_matches(p_access jsonb, p_filter text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case coalesce(p_filter, 'all')
           when 'all' then true
           when 'paid' then p_access ->> 'status' = 'paid' and p_access ->> 'kind' = 'paid'
           when 'expiring' then p_access ->> 'status' = 'paid' and p_access ->> 'kind' = 'paid'
                                and (p_access ->> 'paid_until')::timestamptz <= pg_catalog.now() + interval '7 days'
           when 'trial' then p_access ->> 'status' = 'trial'
           when 'expired' then p_access ->> 'status' = 'expired'
           when 'owner' then p_access ->> 'status' = 'owner'
           when 'legacy' then p_access ->> 'kind' = 'legacy'
           else false end
$$;

-- Главная панели: ученики, подписки, AI, приглашения — одним ответом.
create function public.owner_overview(p_session text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c record;
  v_s jsonb;
  v_i jsonb;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  select jsonb_build_object(
           'total', count(*),
           'paid', count(*) filter (where private.panel_student_matches(st.access, 'paid')),
           'trial', count(*) filter (where private.panel_student_matches(st.access, 'trial')),
           'expired', count(*) filter (where private.panel_student_matches(st.access, 'expired')),
           'owner', count(*) filter (where private.panel_student_matches(st.access, 'owner')),
           'legacy', count(*) filter (where private.panel_student_matches(st.access, 'legacy')),
           'expiring_7d', count(*) filter (where private.panel_student_matches(st.access, 'expiring')))
    into v_s from private.panel_students() st;
  select jsonb_build_object(
           'active', count(*) filter (where x.st = 'active'), 'used', count(*) filter (where x.st = 'used'),
           'expired', count(*) filter (where x.st = 'expired'), 'revoked', count(*) filter (where x.st = 'revoked'),
           'created_today', count(*) filter (where x.source = 'panel' and x.created_at > pg_catalog.now() - interval '24 hours'),
           'daily_limit', 10)
    into v_i
    from (select private.panel_invite_status(i.redeemed_at, m.revoked_at, i.expires_at) st, m.source, m.created_at
            from private.beta_invites i join private.invite_meta m on m.code_hash = i.code_hash) x;
  return jsonb_build_object(
    'owner_kn', v_c.o_kn,
    'students', v_s,
    'subscriptions', jsonb_build_object(
      'active', v_s -> 'paid', 'expiring_7d', v_s -> 'expiring_7d',
      'extensions_total', (select count(*) from private.access_log l where l.action = 'extend'),
      'extensions_30d', (select count(*) from private.access_log l where l.action = 'extend' and l.at > pg_catalog.now() - interval '30 days'),
      'grants_30d', (select count(*) from private.access_log l where l.action = 'grant' and l.at > pg_catalog.now() - interval '30 days')),
    'ai', private.panel_ai_state(),
    'invites', v_i,
    'server_now', pg_catalog.now());
end
$$;

-- Список учеников: поиск по ID (полный или часть), фильтр, страницы.
create function public.owner_students(p_session text, p_query text default null, p_filter text default 'all',
                                      p_limit integer default 20, p_offset integer default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c     record;
  v_q     text := private.panel_normalize(p_query);
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_off   integer := greatest(coalesce(p_offset, 0), 0);
  v_res   jsonb;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  if coalesce(p_filter, 'all') not in ('all', 'paid', 'expiring', 'trial', 'expired', 'owner', 'legacy') then
    return jsonb_build_object('error', 'INVALID_INPUT');
  end if;
  -- «KN-ABC», «kn abc», «ABC» — ищем по символам ID после «KN-»; поиск только по алфавиту ID (без шаблонов LIKE)
  if v_q like 'KN%' then
    v_q := pg_catalog.substr(v_q, 3);
  end if;
  with f as (
    select st.* from private.panel_students() st
     where (v_q = '' or pg_catalog.strpos(pg_catalog.substr(st.kn_id, 4), v_q) > 0)
       and private.panel_student_matches(st.access, p_filter)
  )
  select jsonb_build_object(
           'total', (select count(*) from f),
           'limit', v_limit, 'offset', v_off,
           'items', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'kn_id', p.kn_id, 'registered_at', p.registered_at, 'last_generation_at', p.last_generation_at,
                      'status', p.access ->> 'status', 'kind', p.access ->> 'kind', 'revoked', coalesce((p.access ->> 'revoked')::boolean, false),
                      'ends_at', coalesce(p.access -> 'paid_until', p.access -> 'ends_at'),
                      'ai_quota', p.access -> 'ai_quota', 'ai_used', p.access -> 'ai_used', 'ai_remaining', p.access -> 'ai_remaining')
                    order by p.registered_at desc, p.kn_id)
               from (select * from f order by f.registered_at desc, f.kn_id limit v_limit offset v_off) p), '[]'::jsonb),
           'server_now', pg_catalog.now())
    into v_res;
  return v_res;
end
$$;

-- Карточка ученика: состояние, все сроки, право F&F, журнал (как admin_status, без внутренних номеров).
create function public.owner_student(p_session text, p_kn_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c   record;
  v_kn  text := private.panel_kn_input(p_kn_id);
  v_uid uuid;
  v_st  jsonb;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  if v_kn is null then
    return jsonb_build_object('error', 'INVALID_ID');
  end if;
  v_uid := private.panel_user_by_kn(v_kn);
  if v_uid is null then
    return jsonb_build_object('error', 'USER_NOT_FOUND');
  end if;
  v_st := private.admin_status(v_kn);
  return jsonb_build_object(
    'kn_id', v_kn,
    'registered_at', v_st -> 'registered_at',
    'access', v_st -> 'access',
    'grants', (select coalesce(jsonb_agg(g - 'id'), '[]'::jsonb) from jsonb_array_elements(v_st -> 'grants') g),
    'legacy', v_st -> 'legacy',
    'paid_periods', private.panel_paid_periods(v_uid),
    'starts_24h', v_st -> 'starts_24h', 'user_errors_24h', v_st -> 'user_errors_24h', 'tech_errors_24h', v_st -> 'tech_errors_24h',
    'last_generation_at', (select max(s.started_at) from private.generation_starts s where s.user_id = v_uid),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'actor', l.actor, 'details', l.details - 'grant_id')
                       order by l.at desc, l.id desc)
        from (select * from private.access_log l where l.user_id = v_uid order by l.at desc, l.id desc limit 50) l), '[]'::jsonb),
    'server_now', pg_catalog.now());
end
$$;

-- -------------------------------------------------------------------------------------
-- 6. Подписки: предпросмотр (даты считает сервер) и действия (идемпотентно, через проверенные admin_*)
-- -------------------------------------------------------------------------------------

create function private.panel_extend_start(p_user_id uuid)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select greatest(pg_catalog.now(), coalesce(max(g.ends_at), pg_catalog.now()))
    from private.access_grants g where g.user_id = p_user_id and g.kind = 'paid' and g.revoked_at is null
$$;

create function public.owner_preview(p_session text, p_kn_id text, p_action text, p_days integer default null,
                                     p_ai_quota integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c     record;
  v_kn    text := private.panel_kn_input(p_kn_id);
  v_uid   uuid;
  v_t     record;
  v_start timestamptz;
  v_per   jsonb;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  if v_kn is null then
    return jsonb_build_object('error', 'INVALID_ID');
  end if;
  v_uid := private.panel_user_by_kn(v_kn);
  if v_uid is null then
    return jsonb_build_object('error', 'USER_NOT_FOUND');
  end if;
  v_per := private.panel_paid_periods(v_uid);
  if p_action = 'revoke' then
    if jsonb_array_length(v_per) = 0 then
      return jsonb_build_object('error', 'NOTHING_TO_REVOKE');
    end if;
    return jsonb_build_object('action', 'revoke', 'kn_id', v_kn, 'periods', v_per, 'periods_count', jsonb_array_length(v_per),
                              'access', private.access_state(v_uid), 'server_now', pg_catalog.now());
  end if;
  if p_action not in ('grant', 'extend') then
    return jsonb_build_object('error', 'INVALID_INPUT');
  end if;
  begin
    select * into v_t from private.admin_terms(null, p_days, p_ai_quota);
  exception when others then
    return private.panel_error(sqlstate, sqlerrm);
  end;
  if p_action = 'grant' then
    if jsonb_array_length(v_per) > 0 then
      return jsonb_build_object('error', 'ALREADY_ACTIVE', 'periods', v_per);
    end if;
    v_start := pg_catalog.now();
  else
    if not exists (select 1 from private.access_grants g where g.user_id = v_uid and g.kind = 'paid') then
      return jsonb_build_object('error', 'NO_PAID_YET');
    end if;
    v_start := private.panel_extend_start(v_uid);
  end if;
  return jsonb_build_object(
    'action', p_action, 'kn_id', v_kn, 'days', v_t.days, 'ai_quota', v_t.ai_quota,
    'starts_at', v_start, 'ends_at', v_start + pg_catalog.make_interval(days => v_t.days),
    -- продление встык к действующему сроку; иначе — с момента подтверждения
    'starts_after_current', v_start > pg_catalog.now() + interval '1 second',
    'periods', v_per, 'access', private.access_state(v_uid), 'server_now', pg_catalog.now());
end
$$;

-- Ошибка операции → понятный код (сообщения функций admin_* — без секретов; свои коды KN010…).
create function private.panel_error(p_state text, p_message text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('error',
           case p_state when '22023' then 'INVALID_INPUT' when 'P0002' then 'NOT_FOUND'
                        when '23505' then 'ALREADY_ACTIVE' when '23514' then 'INVALID_INPUT'
                        when 'KN010' then 'STATE_CHANGED' when 'KN011' then 'NO_PAID_YET' when 'KN012' then 'NOTHING_TO_REVOKE'
                        when 'KN013' then 'INVALID_ID' when 'KN014' then 'USER_NOT_FOUND' when 'KN016' then 'DAILY_LIMIT'
                        when 'KN017' then 'INVITE_NOT_FOUND' when 'KN018' then 'ALREADY_USED' when 'KN019' then 'ALREADY_REVOKED'
                        when 'KN020' then 'ALREADY_EXPIRED' when 'KN021' then 'IN_PROGRESS'
                        else 'SERVER_ERROR' end,
           'message', case when p_state in ('22023', 'P0002', '23505', '23514') then p_message end)
$$;

create function private.panel_target(p_kn_id text, out o_kn text, out o_uid uuid)
language plpgsql
stable
set search_path = ''
as $$
begin
  o_kn := private.panel_kn_input(p_kn_id);
  if o_kn is null then
    raise exception 'INVALID_ID' using errcode = 'KN013';
  end if;
  o_uid := private.panel_user_by_kn(o_kn);
  if o_uid is null then
    raise exception 'USER_NOT_FOUND' using errcode = 'KN014';
  end if;
end
$$;

-- Отказ операции панели — в журнал (что и почему; без секретов).
create function private.panel_refused(p_user_id uuid, p_action text, p_result jsonb)
returns void
language sql
volatile
set search_path = ''
as $$
  insert into private.access_log (action, user_id, details)
  values ('panel_refused', p_user_id, jsonb_build_object('op', p_action, 'error', p_result ->> 'error'))
$$;

create function public.owner_grant(p_session text, p_request_id uuid, p_kn_id text, p_days integer, p_ai_quota integer,
                                   p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c   record;
  v_uid uuid;
  v_t   record;
  v_r   jsonb;
  v_g   jsonb;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  v_r := private.panel_request(p_request_id, v_c.o_uid, 'grant',
           jsonb_build_object('kn', p_kn_id, 'days', p_days, 'ai_quota', p_ai_quota, 'note', p_note));
  if v_r is not null then
    return v_r;
  end if;
  begin
    select * into v_t from private.panel_target(p_kn_id);
    v_uid := v_t.o_uid;
    v_g := private.admin_grant(v_t.o_kn, null, p_days, p_ai_quota, nullif(pg_catalog.btrim(p_note), ''), 'panel:' || v_c.o_kn);
    v_r := jsonb_build_object('result', 'granted', 'kn_id', v_t.o_kn,
             'grant', (select jsonb_build_object('starts_at', g.starts_at, 'ends_at', g.ends_at, 'ai_quota', g.ai_quota)
                         from private.access_grants g where g.id = (v_g ->> 'grant_id')::uuid),
             'access', private.access_state(v_t.o_uid));
  exception when others then
    v_r := private.panel_error(sqlstate, sqlerrm);
    perform private.panel_refused(v_uid, 'grant', v_r);
  end;
  return private.panel_request_done(p_request_id, v_r);
end
$$;

create function public.owner_extend(p_session text, p_request_id uuid, p_kn_id text, p_days integer, p_ai_quota integer,
                                    p_note text default null, p_expect_starts_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c     record;
  v_uid uuid;
  v_t     record;
  v_r     jsonb;
  v_g     jsonb;
  v_start timestamptz;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  v_r := private.panel_request(p_request_id, v_c.o_uid, 'extend',
           jsonb_build_object('kn', p_kn_id, 'days', p_days, 'ai_quota', p_ai_quota, 'note', p_note, 'expect', p_expect_starts_at));
  if v_r is not null then
    return v_r;
  end if;
  begin
    select * into v_t from private.panel_target(p_kn_id);
    v_uid := v_t.o_uid;
    perform private.admin_lock(v_t.o_uid);
    if not exists (select 1 from private.access_grants g where g.user_id = v_t.o_uid and g.kind = 'paid') then
      raise exception 'NO_PAID_YET' using errcode = 'KN011';
    end if;
    -- подтверждение относится к тому, что владелец видел: встык к сроку с концом X — или «с этого момента» (NULL)
    v_start := private.panel_extend_start(v_t.o_uid);
    if (v_start > pg_catalog.now() + interval '1 second') then
      if p_expect_starts_at is null or abs(extract(epoch from v_start - p_expect_starts_at)) > 1 then
        raise exception 'STATE_CHANGED' using errcode = 'KN010';
      end if;
    elsif p_expect_starts_at is not null and p_expect_starts_at > pg_catalog.now() then
      raise exception 'STATE_CHANGED' using errcode = 'KN010';
    end if;
    v_g := private.admin_extend(v_t.o_kn, null, p_days, p_ai_quota, nullif(pg_catalog.btrim(p_note), ''), 'panel:' || v_c.o_kn);
    v_r := jsonb_build_object('result', 'extended', 'kn_id', v_t.o_kn,
             'grant', (select jsonb_build_object('starts_at', g.starts_at, 'ends_at', g.ends_at, 'ai_quota', g.ai_quota)
                         from private.access_grants g where g.id = (v_g ->> 'grant_id')::uuid),
             'access', private.access_state(v_t.o_uid));
  exception when others then
    v_r := private.panel_error(sqlstate, sqlerrm);
    perform private.panel_refused(v_uid, 'extend', v_r);
  end;
  return private.panel_request_done(p_request_id, v_r);
end
$$;

-- Отзыв: как admin_revoke — снимаются ВСЕ действующие и будущие оплаченные сроки ученика (владелец видит их список
-- в предпросмотре; p_expect_periods — сколько он видел: если число изменилось, отзыв не выполняется).
create function public.owner_revoke(p_session text, p_request_id uuid, p_kn_id text, p_note text default null,
                                    p_expect_periods integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c record;
  v_uid uuid;
  v_t record;
  v_r jsonb;
  v_g jsonb;
  v_n integer;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  v_r := private.panel_request(p_request_id, v_c.o_uid, 'revoke',
           jsonb_build_object('kn', p_kn_id, 'note', p_note, 'expect', p_expect_periods));
  if v_r is not null then
    return v_r;
  end if;
  begin
    select * into v_t from private.panel_target(p_kn_id);
    v_uid := v_t.o_uid;
    perform private.admin_lock(v_t.o_uid);
    v_n := jsonb_array_length(private.panel_paid_periods(v_t.o_uid));
    if v_n = 0 then
      raise exception 'NOTHING_TO_REVOKE' using errcode = 'KN012';
    end if;
    if p_expect_periods is null or p_expect_periods <> v_n then
      raise exception 'STATE_CHANGED' using errcode = 'KN010';
    end if;
    v_g := private.admin_revoke(v_t.o_kn, nullif(pg_catalog.btrim(p_note), ''), 'paid', 'panel:' || v_c.o_kn);
    v_r := jsonb_build_object('result', 'revoked', 'kn_id', v_t.o_kn, 'revoked', v_g -> 'revoked',
                              'access', private.access_state(v_t.o_uid));
  exception when others then
    v_r := private.panel_error(sqlstate, sqlerrm);
    perform private.panel_refused(v_uid, 'revoke', v_r);
  end;
  return private.panel_request_done(p_request_id, v_r);
end
$$;

-- -------------------------------------------------------------------------------------
-- 7. Приглашения
-- -------------------------------------------------------------------------------------

-- Новый одноразовый код (12 символов алфавита кодов v58, ≈58 бит, генератор pgcrypto). Код возвращается ОДИН раз:
-- в базе только его sha256 (beta_invites.code_hash), в журнале операций и при повторе запроса — без кода.
create function public.owner_invite_create(p_session text, p_request_id uuid, p_label text, p_valid_days integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c     record;
  v_r     jsonb;
  v_code  text;
  v_label text := nullif(pg_catalog.btrim(coalesce(p_label, '')), '');
  v_exp   timestamptz;
  v_id    uuid;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  v_r := private.panel_request(p_request_id, v_c.o_uid, 'invite_create', jsonb_build_object('label', p_label, 'days', p_valid_days));
  if v_r is not null then
    return v_r;
  end if;
  begin
    if p_valid_days is null or p_valid_days not between 1 and 60 then
      raise exception 'Срок действия кода: от 1 до 60 дней' using errcode = '22023';
    end if;
    if pg_catalog.length(coalesce(v_label, '')) > 100 then
      raise exception 'Подпись: не длиннее 100 символов' using errcode = '22023';
    end if;
    -- дневной предел кодов из панели: создание строго по очереди, параллельные запросы предел не обходят
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('konspekt_panel_invites', 0));
    if (select count(*) from private.invite_meta m where m.source = 'panel' and m.created_at > pg_catalog.now() - interval '24 hours') >= 10 then
      raise exception 'DAILY_LIMIT' using errcode = 'KN016';
    end if;
    v_code := private.panel_random(12, 'ABCDEFGHJKMNPQRSTWXYZ23456789');
    v_exp := pg_catalog.now() + pg_catalog.make_interval(days => p_valid_days);
    perform pg_catalog.set_config('konspekt.invite_source', 'panel', true);
    perform pg_catalog.set_config('konspekt.invite_by', v_c.o_uid::text, true);
    insert into private.beta_invites (code_hash, quota, label, expires_at)
    values (private.invite_code_hash(v_code), 1, v_label, v_exp);
    perform pg_catalog.set_config('konspekt.invite_source', '', true);
    perform pg_catalog.set_config('konspekt.invite_by', '', true);
    select m.id into v_id from private.invite_meta m where m.code_hash = private.invite_code_hash(v_code);
    insert into private.access_log (action, details)
    values ('invite_create', jsonb_build_object('invite_id', v_id, 'label', v_label, 'expires_at', v_exp));
    v_r := jsonb_build_object('result', 'created', 'invite_id', v_id, 'label', v_label, 'expires_at', v_exp,
             'code', pg_catalog.substr(v_code, 1, 4) || '-' || pg_catalog.substr(v_code, 5, 4) || '-' || pg_catalog.substr(v_code, 9, 4));
  exception when others then
    v_r := private.panel_error(sqlstate, sqlerrm);
    perform private.panel_refused(null, 'invite_create', v_r);
  end;
  return private.panel_request_done(p_request_id, v_r);
end
$$;

create function public.owner_invites(p_session text, p_filter text default 'all', p_limit integer default 20, p_offset integer default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c     record;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_off   integer := greatest(coalesce(p_offset, 0), 0);
  v_res   jsonb;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  if coalesce(p_filter, 'all') not in ('all', 'active', 'used', 'expired', 'revoked') then
    return jsonb_build_object('error', 'INVALID_INPUT');
  end if;
  with x as (
    select m.id, i.label, m.created_at, i.expires_at, m.source, i.redeemed_at,
           private.panel_invite_status(i.redeemed_at, m.revoked_at, i.expires_at) st,
           m.revoked_at, private.panel_kn(i.redeemed_by) redeemed_kn
      from private.beta_invites i join private.invite_meta m on m.code_hash = i.code_hash
  ), f as (select * from x where coalesce(p_filter, 'all') = 'all' or x.st = p_filter)
  select jsonb_build_object(
    'total', (select count(*) from f), 'limit', v_limit, 'offset', v_off,
    'counts', (select jsonb_build_object('active', count(*) filter (where st = 'active'), 'used', count(*) filter (where st = 'used'),
                                         'expired', count(*) filter (where st = 'expired'), 'revoked', count(*) filter (where st = 'revoked'))
                 from x),
    'created_today', (select count(*) from x where x.source = 'panel' and x.created_at > pg_catalog.now() - interval '24 hours'),
    'daily_limit', 10,
    'items', coalesce((select jsonb_agg(jsonb_build_object('invite_id', p.id, 'label', p.label, 'created_at', p.created_at,
                                                           'expires_at', p.expires_at, 'status', p.st, 'source', p.source,
                                                           'redeemed_kn', p.redeemed_kn, 'redeemed_at', p.redeemed_at,
                                                           'revoked_at', p.revoked_at) order by p.created_at desc, p.id)
                         from (select * from f order by f.created_at desc, f.id limit v_limit offset v_off) p), '[]'::jsonb),
    'server_now', pg_catalog.now())
    into v_res;
  return v_res;
end
$$;

-- Отзыв неиспользованного кода: срок кода заканчивается сейчас — регистрация v58/v59 такой код уже не принимает
-- (register_invite_begin / register_invite_finish проверяют expires_at). Под той же блокировкой строки кода.
create function public.owner_invite_revoke(p_session text, p_request_id uuid, p_invite_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c record;
  v_r jsonb;
  v_i private.beta_invites;
  v_m private.invite_meta;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  v_r := private.panel_request(p_request_id, v_c.o_uid, 'invite_revoke', jsonb_build_object('invite', p_invite_id));
  if v_r is not null then
    return v_r;
  end if;
  begin
    select * into v_m from private.invite_meta m where m.id = p_invite_id;
    if not found then
      raise exception 'INVITE_NOT_FOUND' using errcode = 'KN017';
    end if;
    select * into v_i from private.beta_invites i where i.code_hash = v_m.code_hash for update;
    if v_i.redeemed_at is not null then
      raise exception 'ALREADY_USED' using errcode = 'KN018';
    end if;
    if v_m.revoked_at is not null then
      raise exception 'ALREADY_REVOKED' using errcode = 'KN019';
    end if;
    if v_i.expires_at is not null and v_i.expires_at <= pg_catalog.now() then
      raise exception 'ALREADY_EXPIRED' using errcode = 'KN020';
    end if;
    -- идёт регистрация по этому коду (резерв моложе 15 минут) — не мешаем ей
    if exists (select 1 from private.invite_registrations r
                where r.code_hash = v_i.code_hash and r.updated_at > pg_catalog.now() - interval '15 minutes') then
      raise exception 'IN_PROGRESS' using errcode = 'KN021';
    end if;
    update private.beta_invites set expires_at = pg_catalog.now() where code_hash = v_i.code_hash;
    update private.invite_meta set revoked_at = pg_catalog.now() where code_hash = v_i.code_hash;
    insert into private.access_log (action, details)
    values ('invite_revoke', jsonb_build_object('invite_id', v_m.id, 'label', v_i.label));
    v_r := jsonb_build_object('result', 'revoked', 'invite_id', v_m.id, 'status', 'revoked');
  exception when others then
    v_r := private.panel_error(sqlstate, sqlerrm);
    perform private.panel_refused(null, 'invite_revoke', v_r);
  end;
  return private.panel_request_done(p_request_id, v_r);
end
$$;

-- -------------------------------------------------------------------------------------
-- 8. AI и история
-- -------------------------------------------------------------------------------------

create function public.owner_ai(p_session text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c record;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  return private.panel_ai_state();
end
$$;

-- Журнал: выдачи, продления, отзывы, назначение владельца, пробные, приглашения, отказы панели и события
-- безопасности панели (без паролей, кодов и их отпечатков). Новые сверху, страницы.
create function public.owner_history(p_session text, p_limit integer default 30, p_offset integer default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c     record;
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_off   integer := greatest(coalesce(p_offset, 0), 0);
  v_res   jsonb;
begin
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  with e as (
    select 'access' src, l.id, l.at, l.action, l.user_id, l.actor, l.details - 'grant_id' details from private.access_log l
    union all
    select 'security', s.id, s.at, s.event, s.user_id, null, s.details from private.owner_security_log s
     where s.event in ('setup_code_issued', 'password_set', 'password_changed', 'password_reset', 'unlock_failed', 'locked', 'sessions_revoked')
  )
  select jsonb_build_object(
    'total', (select count(*) from e), 'limit', v_limit, 'offset', v_off,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                         'source', p.src, 'at', p.at, 'type', p.action, 'kn_id', private.panel_kn(p.user_id),
                         'by', case when p.actor like 'panel:%' then 'panel' when p.actor in ('postgres', 'supabase_admin') then 'sql_editor'
                                    when p.actor is null then null else 'system' end,
                         'details', p.details) order by p.at desc, p.src, p.id desc)
                         from (select * from e order by e.at desc, e.src, e.id desc limit v_limit offset v_off) p), '[]'::jsonb),
    'server_now', pg_catalog.now())
    into v_res;
  return v_res;
end
$$;

-- -------------------------------------------------------------------------------------
-- 9. Права: внутренние функции — никому из ролей API; панели — только вошедшим (authenticated),
--    дальше каждая функция сама проверяет владельца, пароль и сессию.
-- -------------------------------------------------------------------------------------

revoke all on function
  private.panel_random(integer, text), private.panel_normalize(text), private.panel_sha256(text),
  private.panel_log(uuid, text, jsonb), private.panel_kn(uuid), private.panel_owner_uid(), private.panel_new_session(uuid),
  private.panel_check(text), private.panel_lock_interval(integer), private.panel_failed_attempt(uuid, text),
  private.panel_store_password(uuid, text), private.panel_error(text, text), private.panel_request(uuid, uuid, text, jsonb),
  private.panel_request_done(uuid, jsonb), private.panel_paid_periods(uuid), private.panel_kn_input(text),
  private.panel_user_by_kn(text), private.panel_invite_status(timestamptz, timestamptz, timestamptz),
  private.invite_meta_on_insert(), private.admin_panel_setup(text), private.admin_panel_revoke_sessions(text),
  private.panel_ai_state(), private.panel_students(), private.panel_student_matches(jsonb, text),
  private.panel_extend_start(uuid), private.panel_target(text), private.panel_refused(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

revoke all on function
  public.owner_panel_state(), public.owner_panel_setup(text, text), public.owner_unlock(text), public.owner_lock(text),
  public.owner_lock_all(text), public.owner_change_password(text, text, text), public.owner_overview(text),
  public.owner_students(text, text, text, integer, integer), public.owner_student(text, text),
  public.owner_preview(text, text, text, integer, integer),
  public.owner_grant(text, uuid, text, integer, integer, text),
  public.owner_extend(text, uuid, text, integer, integer, text, timestamptz),
  public.owner_revoke(text, uuid, text, text, integer),
  public.owner_invite_create(text, uuid, text, integer), public.owner_invites(text, text, integer, integer),
  public.owner_invite_revoke(text, uuid, uuid), public.owner_ai(text), public.owner_history(text, integer, integer)
  from public, anon, authenticated, service_role;

grant execute on function
  public.owner_panel_state(), public.owner_panel_setup(text, text), public.owner_unlock(text), public.owner_lock(text),
  public.owner_lock_all(text), public.owner_change_password(text, text, text), public.owner_overview(text),
  public.owner_students(text, text, text, integer, integer), public.owner_student(text, text),
  public.owner_preview(text, text, text, integer, integer),
  public.owner_grant(text, uuid, text, integer, integer, text),
  public.owner_extend(text, uuid, text, integer, integer, text, timestamptz),
  public.owner_revoke(text, uuid, text, text, integer),
  public.owner_invite_create(text, uuid, text, integer), public.owner_invites(text, text, integer, integer),
  public.owner_invite_revoke(text, uuid, uuid), public.owner_ai(text), public.owner_history(text, integer, integer)
  to authenticated;

commit;

-- =====================================================================================
-- Откат (вручную, одной транзакцией). Удаляет только объекты панели; выдачи, приглашения и журнал остаются.
-- Перед откатом вернуть клиента без панели (кнопка «Панель владельца» тогда показывает ошибку и ничего не меняет).
--
-- begin;
-- drop trigger beta_invites_meta on private.beta_invites;
-- drop function public.owner_history(text, integer, integer);
-- drop function public.owner_ai(text);
-- drop function public.owner_invite_revoke(text, uuid, uuid);
-- drop function public.owner_invites(text, text, integer, integer);
-- drop function public.owner_invite_create(text, uuid, text, integer);
-- drop function public.owner_revoke(text, uuid, text, text, integer);
-- drop function public.owner_extend(text, uuid, text, integer, integer, text, timestamptz);
-- drop function public.owner_grant(text, uuid, text, integer, integer, text);
-- drop function public.owner_preview(text, text, text, integer, integer);
-- drop function public.owner_student(text, text);
-- drop function public.owner_students(text, text, text, integer, integer);
-- drop function public.owner_overview(text);
-- drop function public.owner_change_password(text, text, text);
-- drop function public.owner_lock_all(text);
-- drop function public.owner_lock(text);
-- drop function public.owner_unlock(text);
-- drop function public.owner_panel_setup(text, text);
-- drop function public.owner_panel_state();
-- drop function private.admin_panel_revoke_sessions(text);
-- drop function private.admin_panel_setup(text);
-- drop function private.panel_refused(uuid, text, jsonb);
-- drop function private.panel_target(text);
-- drop function private.panel_extend_start(uuid);
-- drop function private.panel_student_matches(jsonb, text);
-- drop function private.panel_students();
-- drop function private.panel_ai_state();
-- drop function private.invite_meta_on_insert();
-- drop function private.panel_invite_status(timestamptz, timestamptz, timestamptz);
-- drop function private.panel_user_by_kn(text);
-- drop function private.panel_kn_input(text);
-- drop function private.panel_paid_periods(uuid);
-- drop function private.panel_request_done(uuid, jsonb);
-- drop function private.panel_request(uuid, uuid, text, jsonb);
-- drop function private.panel_error(text, text);
-- drop function private.panel_store_password(uuid, text);
-- drop function private.panel_failed_attempt(uuid, text);
-- drop function private.panel_lock_interval(integer);
-- drop function private.panel_check(text);
-- drop function private.panel_new_session(uuid);
-- drop function private.panel_owner_uid();
-- drop function private.panel_kn(uuid);
-- drop function private.panel_log(uuid, text, jsonb);
-- drop function private.panel_sha256(text);
-- drop function private.panel_normalize(text);
-- drop function private.panel_random(integer, text);
-- alter table private.access_log alter column actor set default session_user;
-- drop table private.invite_meta;
-- drop table private.owner_requests;
-- drop table private.owner_security_log;
-- drop table private.owner_panel_sessions;
-- drop table private.owner_panel_secrets;
-- commit;
-- =====================================================================================
