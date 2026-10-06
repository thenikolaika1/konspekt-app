-- =====================================================================================
-- Konspekt: Friends & Family — ранний доступ (BETA) и серверный учёт AI-генераций.
--
-- Только добавляет объекты; существующие таблицы, данные, Auth, Storage и RLS не меняются.
-- analyze-pages этот слой пока НЕ вызывает: до отдельного этапа генерации работают как раньше.
--
-- Источник истины по доступу — сервер:
--   private.user_entitlements — сколько операций ресурса доступно пользователю (quota);
--   private.usage_ledger      — одна строка на операцию (op_key): reserved → consumed | released;
--   private.beta_invites      — одноразовые коды раннего доступа (хранится только sha256).
-- Таблицы лежат в схеме private: она не публикуется через Data API, у ролей API нет к ней прав.
--
-- Клиенту (authenticated) доступны только:
--   public.get_my_access()            — свой доступ: plan, quota, used, reserved, remaining, available;
--   public.redeem_beta_invite(code)   — активировать код для себя (auth.uid()).
-- Только серверу (service_role, Edge Function):
--   public.start_text_generation(user, note, …) — атомарно: захват note + резерв операции.
-- Итог операции фиксирует триггер на public.notes в той же транзакции, что и смена статуса:
--   ready → consumed, failed → released.
--
-- Числа лимита в логике нет: quota берётся из кода приглашения (задаёт администратор при создании)
-- и хранится у каждого пользователя отдельно.
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- 0. Схема private: не публикуется через API, ролям API доступа нет
-- -------------------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;


-- -------------------------------------------------------------------------------------
-- 1. Таблицы
-- -------------------------------------------------------------------------------------

-- Право пользователя на ресурс. Одна строка на (пользователь, ресурс); строка же — объект блокировки
-- при резерве, поэтому параллельные операции одного пользователя выполняются строго по очереди.
create table private.user_entitlements (
  user_id          uuid        not null references auth.users (id) on delete cascade,
  resource         text        not null check (resource in ('text_generation')),
  plan             text        not null check (plan in ('beta', 'free', 'plus')),
  quota            integer     not null check (quota >= 0),
  source           text        not null check (source in ('beta_invite', 'manual')),
  blocked_attempts integer     not null default 0 check (blocked_attempts >= 0),
  last_blocked_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (user_id, resource)
);

-- Журнал операций. op_key — ключ идемпотентности (для конспекта — note_id): одна операция = одна строка,
-- значит не больше одного consumed. Строка переживает удаление note (note_id → NULL), поэтому удаление
-- конспекта не возвращает лимит.
create table private.usage_ledger (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users (id) on delete cascade,
  resource     text        not null check (resource in ('text_generation')),
  op_key       text        not null check (length(op_key) between 1 and 200),
  note_id      uuid        references public.notes (id) on delete set null,
  state        text        not null check (state in ('reserved', 'consumed', 'released')),
  attempts     integer     not null default 1 check (attempts >= 1),
  reserved_at  timestamptz not null default now(),
  expires_at   timestamptz not null,
  finalized_at timestamptz,
  created_at   timestamptz not null default now(),
  constraint usage_ledger_op_unique unique (user_id, resource, op_key),
  constraint usage_ledger_finalized_check check ((state = 'reserved') = (finalized_at is null)),
  constraint usage_ledger_lease_check check (expires_at > reserved_at)
);
-- удаление note: ON DELETE SET NULL ищет строки по note_id
create index usage_ledger_note_id_idx on private.usage_ledger (note_id) where note_id is not null;

-- Одноразовые коды. Хранится только sha256 нормализованного кода; открытый код в БД не попадает.
create table private.beta_invites (
  code_hash   text        primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  quota       integer     not null check (quota > 0),
  label       text        check (label is null or length(label) <= 200),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  redeemed_by uuid        unique references auth.users (id) on delete set null,
  redeemed_at timestamptz,
  -- код погашен, если redeemed_at задан; redeemed_by может стать NULL только при удалении пользователя
  constraint beta_invites_redeemed_check check (redeemed_by is null or redeemed_at is not null)
);

-- Защита в глубину: RLS включён, политик нет, прав у ролей API нет. Читают и пишут только функции ниже.
alter table private.user_entitlements enable row level security;
alter table private.usage_ledger      enable row level security;
alter table private.beta_invites      enable row level security;
revoke all on private.user_entitlements, private.usage_ledger, private.beta_invites
  from public, anon, authenticated, service_role;


-- -------------------------------------------------------------------------------------
-- 2. Внутренние функции (schema private; ролям API недоступны)
-- -------------------------------------------------------------------------------------

-- Нормализация кода: регистр, пробелы и дефисы не важны («knsp-7f3k q9xa» = «KNSP7F3KQ9XA»).
create function private.invite_code_hash(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')), 'UTF8')), 'hex')
$$;

-- used — успешные операции; reserved — активные резервы (истёкшие не считаются).
-- p_exclude_op: резерв этой же операции не считается (повторный захват своей строки).
create function private.usage_counts(p_user_id uuid, p_resource text, p_exclude_op text default null)
returns table (used integer, reserved integer)
language sql
stable
set search_path = ''
as $$
  select
    (count(*) filter (where l.state = 'consumed'))::integer,
    (count(*) filter (where l.state = 'reserved' and l.expires_at > pg_catalog.now()
                        and l.op_key is distinct from p_exclude_op))::integer
  from private.usage_ledger l
  where l.user_id = p_user_id and l.resource = p_resource
$$;

-- Состояние доступа одним объектом (для ответов RPC).
create function private.access_json(p_user_id uuid, p_resource text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'resource', e.resource, 'plan', e.plan, 'quota', e.quota,
    'used', c.used, 'reserved', c.reserved,
    'remaining', greatest(e.quota - c.used, 0),
    'available', greatest(e.quota - c.used - c.reserved, 0))
  from private.user_entitlements e
  cross join lateral private.usage_counts(e.user_id, e.resource) c
  where e.user_id = p_user_id and e.resource = p_resource
$$;

-- Итог генерации конспекта — в той же транзакции, что и смена notes.status (пишет только Edge Function).
-- ready → consumed, failed → released. Затрагивает только резерв этой note этого владельца.
create function private.finalize_note_usage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.usage_ledger
     set state = case when new.status = 'ready' then 'consumed' else 'released' end,
         finalized_at = pg_catalog.now()
   where user_id = new.user_id
     and resource = 'text_generation'
     and op_key = new.id::text
     and state = 'reserved';
  return null;
end
$$;

create trigger notes_finalize_usage
  after update of status on public.notes
  for each row
  when (old.status is distinct from new.status and new.status in ('ready', 'failed'))
  execute function private.finalize_note_usage();


-- -------------------------------------------------------------------------------------
-- 3. RPC для клиента (authenticated)
-- -------------------------------------------------------------------------------------

-- Свой доступ по всем ресурсам. Нет строки — нет доступа (пустой результат).
-- remaining = quota − used (что показывать «Осталось»); available = remaining − активные резервы (можно ли начать).
create function public.get_my_access()
returns table (resource text, plan text, quota integer, used integer, reserved integer, remaining integer, available integer)
language sql
stable
security definer
set search_path = ''
as $$
  select e.resource, e.plan, e.quota, c.used, c.reserved,
         greatest(e.quota - c.used, 0),
         greatest(e.quota - c.used - c.reserved, 0)
  from private.user_entitlements e
  cross join lateral private.usage_counts(e.user_id, e.resource) c
  where e.user_id = auth.uid()
$$;

-- Активация кода для себя. Ответ: { result: activated | already_active | invalid, access }.
-- Неверный, погашенный и просроченный код неразличимы снаружи (invalid).
create function public.redeem_beta_invite(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_quota integer;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  -- нормализованный код короче 8 символов не бывает (коды выпускает администратор, ≥ 12 символов)
  if p_code is null or length(p_code) > 64
     or length(pg_catalog.regexp_replace(p_code, '[^0-9A-Za-z]', '', 'g')) < 8 then
    return jsonb_build_object('result', 'invalid');
  end if;

  -- активации одного пользователя — по очереди (два кода одновременно не дадут два права)
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ff_redeem:' || v_uid::text, 0));

  if exists (select 1 from private.user_entitlements where user_id = v_uid and resource = 'text_generation') then
    -- право уже есть: код не тратим
    return jsonb_build_object('result', 'already_active', 'access', private.access_json(v_uid, 'text_generation'));
  end if;

  -- атомарное погашение: при одновременной активации одного кода строку получит ровно один пользователь
  update private.beta_invites
     set redeemed_by = v_uid, redeemed_at = pg_catalog.now()
   where code_hash = private.invite_code_hash(p_code)
     and redeemed_at is null
     and (expires_at is null or expires_at > pg_catalog.now())
  returning quota into v_quota;

  if not found then
    return jsonb_build_object('result', 'invalid');
  end if;

  insert into private.user_entitlements (user_id, resource, plan, quota, source)
  values (v_uid, 'text_generation', 'beta', v_quota, 'beta_invite');

  return jsonb_build_object('result', 'activated', 'access', private.access_json(v_uid, 'text_generation'));
end
$$;


-- -------------------------------------------------------------------------------------
-- 4. RPC только для сервера (service_role): захват note + резерв в одной транзакции
-- -------------------------------------------------------------------------------------
-- result:
--   started            — note захвачена, операция зарезервирована: можно запускать AI;
--   ready              — конспект уже готов: AI не нужен, ничего не списывается;
--   already_processing — генерация этой note уже идёт (та же логика, что в analyze-pages v18);
--   not_found          — нет такой note у этого пользователя;
--   no_access          — у пользователя нет права на ресурс;
--   limit_reached      — лимит исчерпан: AI не запускать;
--   already_consumed   — операция уже списана, а note не ready (не должно случаться; AI не запускать).
-- Порядок блокировок: note → право пользователя → строка журнала (триггер: note → строка журнала).
create function public.start_text_generation(
  p_user_id       uuid,
  p_note_id       uuid,
  p_stale_seconds integer default 300,
  p_lease_seconds integer default 600
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_note    record;
  v_quota   integer;
  v_state   text;
  v_used    integer;
  v_reserved integer;
  v_op      text := p_note_id::text;
begin
  if p_user_id is null or p_note_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if p_stale_seconds is null or p_lease_seconds is null
     or p_stale_seconds not between 60 and 3600 or p_lease_seconds not between 60 and 3600 then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;

  -- 1. note: строго по очереди для одной note
  select n.user_id, n.status, n.stage, n.updated_at into v_note
    from public.notes n where n.id = p_note_id
     for update;
  if not found or v_note.user_id <> p_user_id then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_note.status = 'ready' then
    return jsonb_build_object('result', 'ready', 'access', private.access_json(p_user_id, 'text_generation'));
  end if;
  -- захват как в v18: failed, processing без stage / не analyzing, «зависший» analyzing
  if not (v_note.status = 'failed'
          or (v_note.status = 'processing'
              and (v_note.stage is null
                   or v_note.stage <> 'analyzing'
                   or v_note.updated_at < pg_catalog.now() - pg_catalog.make_interval(secs => p_stale_seconds)))) then
    return jsonb_build_object('result', 'already_processing');
  end if;

  -- 2. право пользователя: все операции пользователя — строго по очереди
  select e.quota into v_quota
    from private.user_entitlements e
   where e.user_id = p_user_id and e.resource = 'text_generation'
     for update;
  if not found then
    return jsonb_build_object('result', 'no_access');
  end if;

  select l.state into v_state
    from private.usage_ledger l
   where l.user_id = p_user_id and l.resource = 'text_generation' and l.op_key = v_op;
  if v_state = 'consumed' then
    return jsonb_build_object('result', 'already_consumed', 'access', private.access_json(p_user_id, 'text_generation'));
  end if;

  -- 3. лимит: успешные + чужие активные резервы (свой прежний резерв этой же note не считается)
  select c.used, c.reserved into v_used, v_reserved
    from private.usage_counts(p_user_id, 'text_generation', v_op) c;
  if v_used + v_reserved >= v_quota then
    update private.user_entitlements
       set blocked_attempts = blocked_attempts + 1, last_blocked_at = pg_catalog.now(), updated_at = pg_catalog.now()
     where user_id = p_user_id and resource = 'text_generation';
    return jsonb_build_object('result', 'limit_reached', 'access', private.access_json(p_user_id, 'text_generation'));
  end if;

  -- 4. резерв: новая строка или повтор той же операции (released / просроченный reserved)
  insert into private.usage_ledger as l (user_id, resource, op_key, note_id, state, reserved_at, expires_at)
  values (p_user_id, 'text_generation', v_op, p_note_id, 'reserved', pg_catalog.now(),
          pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds))
  on conflict (user_id, resource, op_key) do update
     set state        = 'reserved',
         note_id      = excluded.note_id,
         attempts     = l.attempts + 1,
         reserved_at  = excluded.reserved_at,
         expires_at   = excluded.expires_at,
         finalized_at = null
   where l.state <> 'consumed';

  -- 5. захват note (как в v18)
  update public.notes
     set status = 'processing', stage = 'analyzing', error_code = null, updated_at = pg_catalog.now()
   where id = p_note_id;

  return jsonb_build_object('result', 'started', 'access', private.access_json(p_user_id, 'text_generation'));
end
$$;


-- -------------------------------------------------------------------------------------
-- 5. Администрирование (schema private; вызывается только из SQL Editor владельцем)
-- -------------------------------------------------------------------------------------

-- Новый код: передаётся только sha256 нормализованного кода (открытый код в SQL и логи не попадает).
-- quota — для этого кода; позже новые коды можно выпускать с другим значением, старые права не меняются.
create function private.admin_add_beta_invite(p_code_hash text, p_quota integer, p_label text default null,
                                              p_expires_at timestamptz default null)
returns void
language sql
set search_path = ''
as $$
  insert into private.beta_invites (code_hash, quota, label, expires_at)
  values (pg_catalog.lower(p_code_hash), p_quota, p_label, p_expires_at)
$$;

-- Право конкретного пользователя: создать или изменить (например, свой тестовый доступ или «Мише 10»).
create function private.admin_set_entitlement(p_user_id uuid, p_quota integer, p_plan text default 'beta',
                                              p_source text default 'manual')
returns void
language sql
set search_path = ''
as $$
  insert into private.user_entitlements (user_id, resource, plan, quota, source)
  values (p_user_id, 'text_generation', p_plan, p_quota, p_source)
  on conflict (user_id, resource) do update
     set quota = excluded.quota, plan = excluded.plan, updated_at = pg_catalog.now()
$$;

-- Массовое повышение: всем BETA, у кого quota меньше p_min_quota, поднять до p_min_quota.
-- Только повышает; блокирует строки прав, поэтому безопасна во время генераций. Возвращает число строк.
create function private.admin_raise_beta_quota(p_min_quota integer)
returns integer
language sql
set search_path = ''
as $$
  with u as (
    update private.user_entitlements
       set quota = p_min_quota, updated_at = pg_catalog.now()
     where plan = 'beta' and resource = 'text_generation' and quota < p_min_quota
    returning 1
  )
  select count(*)::integer from u
$$;


-- -------------------------------------------------------------------------------------
-- 6. Права на функции: по умолчанию никому, затем точечно
-- -------------------------------------------------------------------------------------

revoke all on function
  private.invite_code_hash(text),
  private.usage_counts(uuid, text, text),
  private.access_json(uuid, text),
  private.finalize_note_usage(),
  private.admin_add_beta_invite(text, integer, text, timestamptz),
  private.admin_set_entitlement(uuid, integer, text, text),
  private.admin_raise_beta_quota(integer),
  public.get_my_access(),
  public.redeem_beta_invite(text),
  public.start_text_generation(uuid, uuid, integer, integer)
from public, anon, authenticated, service_role;

grant execute on function public.get_my_access()                                   to authenticated;
grant execute on function public.redeem_beta_invite(text)                          to authenticated;
grant execute on function public.start_text_generation(uuid, uuid, integer, integer) to service_role;


-- -------------------------------------------------------------------------------------
-- Откат (только вручную, удаляет учёт F&F; существующие таблицы не затрагивает):
--   drop trigger if exists notes_finalize_usage on public.notes;
--   drop function if exists public.start_text_generation(uuid, uuid, integer, integer),
--     public.redeem_beta_invite(text), public.get_my_access();
--   drop schema if exists private cascade;
-- -------------------------------------------------------------------------------------
