-- =====================================================================================
-- Konspekt v58: самостоятельная регистрация по одноразовому приглашению.
--
-- Сценарий: ученик вводит код → приложение генерирует ID (KN-XXXXXX) и секретный ключ → Edge Function
-- register-invite (service_role) резервирует код, создаёт пользователя Supabase Auth (технический email
-- id-kn-…@id.konspekt.invalid, пароль из ключа) и завершает регистрацию: право beta_invite (quota 1) +
-- погашение кода. Организатор выпускает только коды (tools/ff-invite-codes.mjs), ключей учеников не видит.
--
-- Атомарность. Supabase Auth Admin API и транзакция PostgreSQL — НЕ одна транзакция, поэтому:
--   1) register_invite_begin — под блокировкой строки кода резервирует его за одним ID (private.invite_registrations);
--      повтор с тем же ID продолжает ту же регистрацию (resume), с другим ID — отказ, пока резерв свежий;
--   2) пользователь Auth создаётся с меткой резерва в app_metadata.kn_reservation (её пишет только сервер) — по ней повтор после потерянного
--      ответа находит «своего» пользователя, а не создаёт второго;
--   3) register_invite_finish — одна транзакция: проверка резерва и пользователя → право → погашение кода → резерв удалён.
-- Пока шаг 3 не выполнен, у пользователя нет права (AI недоступен) — такой аккаунт безопасен. Зависший резерв
-- (> 15 мин) может забрать другое устройство: прежний пользователь без права возвращается функцией для удаления.
-- Один код → не больше одного права: право выдаётся только в шаге 3 под блокировкой кода, код гасится там же.
--
-- public.redeem_beta_invite (активация кода текущим, в том числе анонимным, пользователем) отключена: право по коду
-- теперь только у аккаунта, созданного регистрацией (иначе гость мог бы погасить код на анонимный uid).
--
-- Не меняются: квоты, окно F&F, лимиты AI, RLS существующих таблиц, analyze-pages.
-- Применять вручную после 20261011130200. Откат — в конце файла.
-- =====================================================================================

-- Незавершённые регистрации: не больше одной на код
create table private.invite_registrations (
  code_hash   text        primary key references private.beta_invites (code_hash) on delete cascade,
  reservation uuid        not null unique,
  kn_id       text        not null check (kn_id ~ '^KN-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Попытки регистрации по IP (хэш с солью из Edge Function; сам IP не хранится) — ограничение частоты
create table private.register_attempts (
  id         bigint      generated always as identity primary key,
  ip_hash    text        not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  ok         boolean     not null,
  created_at timestamptz not null default now()
);
create index register_attempts_ip_time on private.register_attempts (ip_hash, created_at);
create index register_attempts_time on private.register_attempts (created_at);

alter table private.invite_registrations enable row level security;
alter table private.register_attempts    enable row level security;
revoke all on private.invite_registrations, private.register_attempts from public, anon, authenticated, service_role;

-- Технический логин ID: как в js/cloud.js (idLogin)
create function private.kn_email(p_kn_id text)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'id-' || pg_catalog.lower(p_kn_id) || '@id.konspekt.invalid'
$$;

-- -------------------------------------------------------------------------------------
-- Шаг 1. Резерв кода. Ответ result:
--   reserved | resume   — продолжать: reservation, user_id (если пользователь этого резерва уже создан),
--                          orphan_user_id (пользователь брошенного чужого резерва — удалить, у него нет права)
--   done                 — код уже погашен этим же ID (повтор после потерянного ответа): входить
--   invalid | expired | used | busy | id_taken | rate_limited | bad_request
-- -------------------------------------------------------------------------------------
create function public.register_invite_begin(p_code text, p_kn_id text, p_ip_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  STALE    constant interval := interval '15 minutes';
  v_hash   text;
  v_inv    record;
  v_reg    record;
  v_email  text;
  v_owner  uuid;
  v_uid    uuid;
  v_orphan uuid;
  v_res    uuid;
  v_out    jsonb;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' or p_kn_id is null
     or p_kn_id !~ '^KN-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$' then
    return jsonb_build_object('result', 'bad_request');
  end if;

  -- журнал попыток нужен только за последний час — старое удаляется
  delete from private.register_attempts where created_at < pg_catalog.now() - interval '1 day';

  -- частота: не больше 30 неудачных попыток за час и 60 любых за 10 минут с одного IP (класс за одним IP школы —
  -- несколько учеников с опечатками не должны блокировать остальных; перебор 12-символьных кодов всё равно невозможен)
  if (select count(*) from private.register_attempts
       where ip_hash = p_ip_hash and not ok and created_at > pg_catalog.now() - interval '1 hour') >= 30
     or (select count(*) from private.register_attempts
          where ip_hash = p_ip_hash and created_at > pg_catalog.now() - interval '10 minutes') >= 60 then
    return jsonb_build_object('result', 'rate_limited');
  end if;

  v_out := null;
  if p_code is null or length(p_code) > 64 or length(private.invite_code_normalize(p_code)) < 8 then
    v_out := jsonb_build_object('result', 'invalid');
  end if;

  if v_out is null then
    v_hash := private.invite_code_hash(p_code);
    select * into v_inv from private.beta_invites where code_hash = v_hash for update;
    if not found then
      v_out := jsonb_build_object('result', 'invalid');
    end if;
  end if;

  if v_out is null then
    v_email := private.kn_email(p_kn_id);
    if v_inv.redeemed_at is not null then
      -- погашен: тем же ID (повтор после потерянного ответа) — успех, иначе «использован»
      select u.id into v_owner from auth.users u where u.id = v_inv.redeemed_by and u.email = v_email;
      v_out := case when v_owner is not null
                    then jsonb_build_object('result', 'done', 'user_id', v_owner)
                    else jsonb_build_object('result', 'used') end;
    elsif v_inv.expires_at is not null and v_inv.expires_at <= pg_catalog.now() then
      v_out := jsonb_build_object('result', 'expired');
    end if;
  end if;

  if v_out is null then
    select * into v_reg from private.invite_registrations where code_hash = v_hash for update;
    if found and v_reg.kn_id = p_kn_id then
      -- тот же ID: продолжаем ту же регистрацию (двойное нажатие, повтор, перезапуск браузера)
      update private.invite_registrations set updated_at = pg_catalog.now() where code_hash = v_hash;
      select u.id into v_uid from auth.users u
       where u.email = v_email and u.raw_app_meta_data ->> 'kn_reservation' = v_reg.reservation::text;
      v_out := jsonb_build_object('result', 'resume', 'reservation', v_reg.reservation, 'user_id', v_uid);
    elsif found and v_reg.updated_at > pg_catalog.now() - STALE
          -- резерв, чей ID уже занят чужим аккаунтом, завершиться не может — его не ждём
          and not exists (select 1 from auth.users u
                           where u.email = private.kn_email(v_reg.kn_id)
                             and coalesce(u.raw_app_meta_data ->> 'kn_reservation', '') <> v_reg.reservation::text) then
      v_out := jsonb_build_object('result', 'busy');
    else
      -- ID уже занят другим аккаунтом — клиент сгенерирует другой
      if exists (select 1 from auth.users u where u.email = v_email) then
        v_out := jsonb_build_object('result', 'id_taken');
      else
        if found then
          -- брошенный резерв другого устройства: его пользователь (если создан) без права — удалить
          select u.id into v_orphan from auth.users u
           where u.raw_app_meta_data ->> 'kn_reservation' = v_reg.reservation::text
             and not exists (select 1 from private.user_entitlements e where e.user_id = u.id);
          delete from private.invite_registrations where code_hash = v_hash;
        end if;
        v_res := gen_random_uuid();
        insert into private.invite_registrations (code_hash, reservation, kn_id) values (v_hash, v_res, p_kn_id);
        v_out := jsonb_build_object('result', 'reserved', 'reservation', v_res, 'orphan_user_id', v_orphan);
      end if;
    end if;
  end if;

  insert into private.register_attempts (ip_hash, ok)
  values (p_ip_hash, v_out ->> 'result' in ('reserved', 'resume', 'done', 'id_taken', 'busy'));
  return v_out;
end
$$;

-- -------------------------------------------------------------------------------------
-- Шаг 3. Завершение (одна транзакция). Ответ result: done | used | expired | busy | invalid_state
-- -------------------------------------------------------------------------------------
create function public.register_invite_finish(p_code text, p_reservation uuid, p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hash text := private.invite_code_hash(p_code);
  v_inv  record;
  v_reg  record;
begin
  select * into v_inv from private.beta_invites where code_hash = v_hash for update;
  if not found then
    return jsonb_build_object('result', 'invalid_state');
  end if;
  if v_inv.redeemed_at is not null then
    return jsonb_build_object('result', case when v_inv.redeemed_by = p_user_id then 'done' else 'used' end);
  end if;
  if v_inv.expires_at is not null and v_inv.expires_at <= pg_catalog.now() then
    return jsonb_build_object('result', 'expired');
  end if;

  select * into v_reg from private.invite_registrations where code_hash = v_hash for update;
  if not found or v_reg.reservation <> p_reservation then
    return jsonb_build_object('result', 'busy');
  end if;
  -- пользователь — именно созданный этим резервом и с этим ID
  if not exists (select 1 from auth.users u
                  where u.id = p_user_id and u.email = private.kn_email(v_reg.kn_id)
                    and u.raw_app_meta_data ->> 'kn_reservation' = p_reservation::text
                    and not u.is_anonymous) then
    return jsonb_build_object('result', 'invalid_state');
  end if;
  if exists (select 1 from private.user_entitlements e where e.user_id = p_user_id and e.resource = 'text_generation') then
    return jsonb_build_object('result', 'invalid_state');
  end if;

  -- F&F: одна успешная генерация на аккаунт (попытки ограничивает ai_limits.max_user_starts)
  insert into private.user_entitlements (user_id, resource, plan, quota, source)
  values (p_user_id, 'text_generation', 'beta', 1, 'beta_invite');
  update private.beta_invites set redeemed_by = p_user_id, redeemed_at = pg_catalog.now() where code_hash = v_hash;
  delete from private.invite_registrations where code_hash = v_hash;
  return jsonb_build_object('result', 'done');
end
$$;

-- Прежняя активация кода текущим пользователем отключена (контракт ответа сохранён для старых клиентов)
create or replace function public.redeem_beta_invite(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  return jsonb_build_object('result', 'registration_required');
end
$$;

-- Сводка для организатора (только чтение, SQL Editor): сколько кодов выпущено, погашено, в процессе
create function private.invite_status()
returns table (issued bigint, redeemed bigint, expired bigint, in_progress bigint, beta_invite_accounts bigint)
language sql
stable
set search_path = ''
as $$
  select (select count(*) from private.beta_invites),
         (select count(*) from private.beta_invites where redeemed_at is not null),
         (select count(*) from private.beta_invites where redeemed_at is null and expires_at <= pg_catalog.now()),
         (select count(*) from private.invite_registrations),
         (select count(*) from private.user_entitlements where source = 'beta_invite')
$$;

revoke all on function
  private.kn_email(text),
  private.invite_status(),
  public.register_invite_begin(text, text, text),
  public.register_invite_finish(text, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.register_invite_begin(text, text, text)  to service_role;
grant execute on function public.register_invite_finish(text, uuid, uuid) to service_role;

-- -------------------------------------------------------------------------------------
-- Откат (только вручную, когда регистраций в процессе нет):
--   drop function public.register_invite_begin(text, text, text);
--   drop function public.register_invite_finish(text, uuid, uuid);
--   drop function private.invite_status(); drop function private.kn_email(text);
--   drop table private.invite_registrations; drop table private.register_attempts;
--   public.redeem_beta_invite — тело из 20261011120500 (create or replace).
-- Выданные права и погашенные коды откат не трогает.
-- -------------------------------------------------------------------------------------
