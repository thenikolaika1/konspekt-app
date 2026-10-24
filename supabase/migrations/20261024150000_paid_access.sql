-- =====================================================================================
-- Konspekt v61: пробный период и платный доступ (выдаёт владелец вручную).
--
-- Только добавляет объекты; существующие таблицы, строки, лимиты AI, приглашения, Auth и RLS не меняются.
-- Единственное изменение существующей таблицы — новое пустое поле usage_ledger.grant_id (старые строки: NULL).
--
-- Источник истины — сервер (now() базы), часы и код клиента не участвуют:
--   private.access_grants   — выдачи доступа: trial (7 дней при регистрации), paid (выдаёт владелец), owner (бессрочно);
--                             у каждой выдачи свой срок и свой лимит генераций (неиспользованные не переносятся);
--   private.plans           — справочник тарифов (пустой: тарифы задаёт владелец позже);
--   private.access_settings — параметры пробного периода (7 дней, 1 генерация);
--   private.access_log      — журнал выдач, продлений и отзывов.
--
-- Клиенту (authenticated):  public.get_my_access_v2(), public.get_plans().
-- Серверу (service_role):    public.start_text_generation_v2(…) — проверка и резерв генерации для analyze-pages.
-- Владельцу (SQL Editor):    private.admin_status / admin_grant / admin_extend / admin_revoke / admin_set_owner /
--                            admin_grant_trial — ролям API недоступны.
--
-- Совместимость. Пользователь без единой выдачи (7 участников F&F, анонимные служебные аккаунты, гости) проверяется
-- прежней логикой: start_text_generation_v2 вызывает старую start_text_generation без изменений, get_my_access_v2
-- описывает старое право (kind = legacy). Старая public.get_my_access (клиенты v59) не меняется.
-- Пробный период выдаётся только новым регистрациям (триггер на появление права приглашения) — задним числом никому.
--
-- Порядок блокировок (без взаимных блокировок):
--   генерация (новая логика): note → пользователь (advisory) → ai_limits → строка журнала;
--   генерация (старая логика): note → user_entitlements → ai_limits → строка журнала (без изменений);
--   функции владельца: пользователь (advisory) → access_grants; триггер итога: note → строка журнала.
--
-- Применять вручную после 20261018130000 (Dashboard → SQL Editor), до выпуска analyze-pages и клиента v61.
-- Откат — в конце файла.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 1. Таблицы
-- -------------------------------------------------------------------------------------

-- Параметры пробного периода (одна строка). attempts_per_generation — сколько запусков (включая неудачные)
-- даёт одна генерация лимита: неудачи лимит не тратят, но бесконечных повторов нет (как max_user_starts у F&F).
create table private.access_settings (
  id                      boolean     primary key default true check (id),
  trial_on_register       boolean     not null default true,
  trial_days              integer     not null default 7 check (trial_days between 1 and 60),
  trial_ai_quota          integer     not null default 1 check (trial_ai_quota >= 0),
  attempts_per_generation integer     not null default 3 check (attempts_per_generation between 1 and 10),
  updated_at              timestamptz not null default now()
);
insert into private.access_settings default values;

-- Тарифы. Пусто: названия, сроки, лимиты и цены задаёт владелец. В приложении видны только active = true.
create table private.plans (
  code        text        primary key check (code ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  title       text        not null check (length(title) between 1 and 80),
  days        integer     not null check (days between 1 and 400),
  ai_quota    integer     not null check (ai_quota between 0 and 1000),
  price_label text        check (price_label is null or length(price_label) between 1 and 60),
  description text        check (description is null or length(description) between 1 and 300),
  active      boolean     not null default false,
  sort_order  integer     not null default 100,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Выдачи доступа. Одна строка — один срок со своим лимитом; продление — новая строка, отзыв — revoked_at (без удаления).
-- owner: бессрочно (ends_at NULL) и без личного лимита (ai_quota NULL); общие лимиты ai_limits действуют и для него.
create table private.access_grants (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  kind       text        not null check (kind in ('trial', 'paid', 'owner')),
  plan       text        references private.plans (code) on update cascade,
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz,
  ai_quota   integer     check (ai_quota is null or ai_quota between 0 and 1000),
  granted_by text        not null default 'system' check (length(granted_by) between 1 and 60),
  note       text        check (note is null or length(note) <= 300),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint access_grants_period check (ends_at is null or ends_at > starts_at),
  constraint access_grants_owner check ((kind = 'owner') = (ends_at is null)),
  constraint access_grants_quota check ((kind = 'owner') = (ai_quota is null))
);
-- один пробный период на аккаунт
create unique index access_grants_one_trial on private.access_grants (user_id) where kind = 'trial';
create index access_grants_user on private.access_grants (user_id, starts_at);

-- Журнал операций владельца и выдачи пробного периода. user_id без внешнего ключа: запись переживает аккаунт.
create table private.access_log (
  id       bigint      generated always as identity primary key,
  at       timestamptz not null default now(),
  action   text        not null,
  user_id  uuid,
  grant_id uuid,
  actor    text        not null default session_user,
  details  jsonb       not null default '{}'::jsonb
);
create index access_log_user on private.access_log (user_id, at);

-- Генерация — в счёт какой выдачи. Старые строки (F&F, служебные) остаются с NULL и считаются как раньше.
alter table private.usage_ledger
  add column grant_id uuid references private.access_grants (id) on delete set null;
create index usage_ledger_grant_idx on private.usage_ledger (grant_id) where grant_id is not null;

alter table private.access_settings enable row level security;
alter table private.plans           enable row level security;
alter table private.access_grants   enable row level security;
alter table private.access_log      enable row level security;
revoke all on private.access_settings, private.plans, private.access_grants, private.access_log
  from public, anon, authenticated, service_role;

-- -------------------------------------------------------------------------------------
-- 2. Внутренние функции
-- -------------------------------------------------------------------------------------

-- Действующая выдача на момент p_at: владелец > оплаченная > пробная; среди равных — начавшаяся раньше.
create function private.active_grant(p_user_id uuid, p_at timestamptz default pg_catalog.now())
returns setof private.access_grants
language sql
stable
set search_path = ''
as $$
  select g.*
    from private.access_grants g
   where g.user_id = p_user_id and g.revoked_at is null
     and g.starts_at <= p_at and (g.ends_at is null or g.ends_at > p_at)
   order by case g.kind when 'owner' then 0 when 'paid' then 1 else 2 end, g.starts_at, g.created_at
   limit 1
$$;

-- Использование одной выдачи: успешные, активные резервы (кроме p_exclude_op), все запуски.
create function private.grant_usage(p_grant_id uuid, p_exclude_op text default null)
returns table (used integer, reserved integer, starts integer)
language sql
stable
set search_path = ''
as $$
  select (count(*) filter (where l.state = 'consumed'))::integer,
         (count(*) filter (where l.state = 'reserved' and l.expires_at > pg_catalog.now()
                             and l.op_key is distinct from p_exclude_op))::integer,
         coalesce(sum(l.attempts), 0)::integer
    from private.usage_ledger l
   where l.grant_id = p_grant_id
$$;

-- Состояние доступа пользователя (одно на всё приложение). status: owner | paid | trial | expired | none.
-- kind — откуда состояние: trial / paid / owner (выдачи) или legacy (старое право, если выдач нет).
-- ai_quota NULL — без личного лимита. server_now — время сервера: клиент считает «осталось N дней» от него.
create function private.access_state(p_user_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_now   timestamptz := pg_catalog.now();
  v_g     private.access_grants;
  v_u     record;
  v_next  timestamptz;
  v_last  record;
  v_ent   record;
  v_lim   record;
  v_cnt   record;
  v_act   boolean;
begin
  if p_user_id is null then
    return jsonb_build_object('status', 'none', 'kind', null, 'server_now', v_now);
  end if;

  select * into v_g from private.active_grant(p_user_id, v_now);
  if v_g.id is not null then
    select * into v_u from private.grant_usage(v_g.id);
    -- оплаченный срок, продлённый заранее: до какой даты доступ непрерывен
    select max(g.ends_at) into v_next
      from private.access_grants g
     where g.user_id = p_user_id and g.revoked_at is null and g.kind = 'paid' and g.ends_at > v_now;
    return jsonb_build_object(
      'status', v_g.kind, 'kind', v_g.kind, 'plan', v_g.plan,
      'plan_title', (select p.title from private.plans p where p.code = v_g.plan),
      'starts_at', v_g.starts_at, 'ends_at', v_g.ends_at,
      'paid_until', case when v_g.kind = 'paid' then v_next end,
      'server_now', v_now,
      'ai_quota', v_g.ai_quota, 'ai_used', v_u.used, 'ai_reserved', v_u.reserved,
      'ai_remaining', case when v_g.ai_quota is null then null else greatest(v_g.ai_quota - v_u.used, 0) end,
      'ai_available', case when v_g.ai_quota is null then null else greatest(v_g.ai_quota - v_u.used - v_u.reserved, 0) end);
  end if;

  -- выдачи были, но ни одна не действует: последняя закончившаяся (или отозванная) — для текста экрана
  select g.kind, g.plan, g.starts_at, least(coalesce(g.revoked_at, g.ends_at), coalesce(g.ends_at, g.revoked_at)) as ended_at,
         g.revoked_at is not null as revoked
    into v_last
    from private.access_grants g
   where g.user_id = p_user_id and g.starts_at <= v_now
   order by least(coalesce(g.revoked_at, g.ends_at), coalesce(g.ends_at, g.revoked_at)) desc nulls last
   limit 1;
  if found then
    return jsonb_build_object(
      'status', 'expired', 'kind', v_last.kind, 'plan', v_last.plan, 'starts_at', v_last.starts_at,
      'ends_at', v_last.ended_at, 'revoked', v_last.revoked, 'server_now', v_now,
      'ai_quota', 0, 'ai_used', 0, 'ai_reserved', 0, 'ai_remaining', 0, 'ai_available', 0);
  end if;
  if exists (select 1 from private.access_grants g where g.user_id = p_user_id) then
    -- только будущая выдача (так не выдаётся, но состояние должно быть честным)
    return jsonb_build_object('status', 'none', 'kind', null, 'server_now', v_now);
  end if;

  -- выдач нет: старое право (F&F по приглашению или ручное служебное) — как его видит прежняя проверка
  select e.source, e.quota into v_ent
    from private.user_entitlements e
   where e.user_id = p_user_id and e.resource = 'text_generation';
  if found then
    select * into v_lim from private.ai_limits limit 1;
    select * into v_cnt from private.usage_counts(p_user_id, 'text_generation');
    v_act := private.entitlement_active(v_ent.source);
    return jsonb_build_object(
      'status', case when not v_act then 'expired' when v_ent.source = 'beta_invite' then 'trial' else 'paid' end,
      'kind', 'legacy', 'plan', null, 'legacy_source', v_ent.source,
      'starts_at', case when v_ent.source = 'beta_invite' then v_lim.beta_starts_at end,
      'ends_at', case when v_ent.source = 'beta_invite' then v_lim.beta_ends_at end,
      'server_now', v_now,
      'ai_quota', v_ent.quota, 'ai_used', v_cnt.used, 'ai_reserved', v_cnt.reserved,
      'ai_remaining', case when v_act then greatest(v_ent.quota - v_cnt.used, 0) else 0 end,
      'ai_available', case when v_act then greatest(v_ent.quota - v_cnt.used - v_cnt.reserved, 0) else 0 end);
  end if;
  return jsonb_build_object('status', 'none', 'kind', null, 'server_now', v_now);
end
$$;

-- Пробный период при регистрации по приглашению: право beta_invite выдаёт только register_invite_finish
-- (одна транзакция с погашением кода), поэтому один код → один аккаунт → один пробный период.
create function private.grant_trial_on_register()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s  private.access_settings;
  v_id uuid;
begin
  if new.source <> 'beta_invite' or new.resource <> 'text_generation' then
    return null;
  end if;
  select * into v_s from private.access_settings limit 1;
  if not found or not v_s.trial_on_register then
    return null;
  end if;
  insert into private.access_grants (user_id, kind, starts_at, ends_at, ai_quota, granted_by, note)
  values (new.user_id, 'trial', pg_catalog.now(), pg_catalog.now() + pg_catalog.make_interval(days => v_s.trial_days),
          v_s.trial_ai_quota, 'register', 'пробный период при регистрации')
  on conflict (user_id) where kind = 'trial' do nothing
  returning id into v_id;
  if v_id is not null then
    insert into private.access_log (action, user_id, grant_id, actor, details)
    values ('trial_on_register', new.user_id, v_id, 'register',
            jsonb_build_object('days', v_s.trial_days, 'ai_quota', v_s.trial_ai_quota));
  end if;
  return null;
end
$$;

create trigger user_entitlements_trial
  after insert on private.user_entitlements
  for each row execute function private.grant_trial_on_register();

-- -------------------------------------------------------------------------------------
-- 3. RPC для клиента (authenticated)
-- -------------------------------------------------------------------------------------

-- Свой доступ (пользователь — из JWT). Чужие данные недоступны: аргументов нет.
create function public.get_my_access_v2()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.access_state(auth.uid())
$$;

-- Активные тарифы для экрана «Тарифы» (пустой список — тарифы ещё не заданы).
create function public.get_plans()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'title', p.title, 'days', p.days, 'ai_quota', p.ai_quota,
                                               'price_label', p.price_label, 'description', p.description)
                            order by p.sort_order, p.title), '[]'::jsonb)
    from private.plans p
   where p.active
$$;

-- -------------------------------------------------------------------------------------
-- 4. RPC только для сервера (service_role): проверка и резерв генерации
-- -------------------------------------------------------------------------------------
-- Результаты — как у start_text_generation (analyze-pages их уже понимает):
--   started | ready | already_processing | not_found | no_access | access_expired | limit_reached |
--   too_many_pages | ai_paused | ai_busy | already_consumed.
create function public.start_text_generation_v2(
  p_user_id       uuid,
  p_note_id       uuid,
  p_stale_seconds integer default 300,
  p_lease_seconds integer default 600,
  p_page_count    integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_note  record;
  v_lim   record;
  v_g     private.access_grants;
  v_u     record;
  v_state text;
  v_per   integer;
  v_op    text := p_note_id::text;
begin
  if p_user_id is null or p_note_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if p_stale_seconds is null or p_lease_seconds is null
     or p_stale_seconds not between 60 and 3600 or p_lease_seconds not between 60 and 3600
     or (p_page_count is not null and p_page_count < 1) then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;

  -- выдач нет — прежняя проверка без изменений (F&F, служебные анонимные аккаунты)
  if not exists (select 1 from private.access_grants g where g.user_id = p_user_id) then
    return public.start_text_generation(p_user_id, p_note_id, p_stale_seconds, p_lease_seconds, p_page_count);
  end if;

  -- 1. note: строго по очереди для одной note (как в start_text_generation)
  select n.user_id, n.status, n.stage, n.updated_at into v_note
    from public.notes n where n.id = p_note_id
     for update;
  if not found or v_note.user_id <> p_user_id then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_note.status = 'ready' then
    return jsonb_build_object('result', 'ready', 'access', private.access_state(p_user_id));
  end if;
  if not (v_note.status = 'failed'
          or (v_note.status = 'processing'
              and (v_note.stage is null
                   or v_note.stage <> 'analyzing'
                   or v_note.updated_at < pg_catalog.now() - pg_catalog.make_interval(secs => p_stale_seconds)))) then
    return jsonb_build_object('result', 'already_processing');
  end if;

  -- 2. пользователь: все его генерации и операции владельца с его доступом — строго по очереди
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('konspekt_access:' || p_user_id::text, 0));

  -- 3. общие настройки AI: все запуски — по очереди (бюджет и одновременные генерации)
  select * into v_lim from private.ai_limits for update;
  if not found then
    return jsonb_build_object('result', 'ai_paused');
  end if;
  if p_page_count is not null and p_page_count > v_lim.max_pages then
    return jsonb_build_object('result', 'too_many_pages', 'max_pages', v_lim.max_pages);
  end if;

  -- 4. действующая выдача (срок — по часам сервера)
  select * into v_g from private.active_grant(p_user_id);
  if v_g.id is null then
    return jsonb_build_object('result', 'access_expired', 'access', private.access_state(p_user_id));
  end if;

  select l.state into v_state
    from private.usage_ledger l
   where l.user_id = p_user_id and l.resource = 'text_generation' and l.op_key = v_op;
  if v_state = 'consumed' then
    return jsonb_build_object('result', 'already_consumed', 'access', private.access_state(p_user_id));
  end if;

  -- 5. личный лимит выдачи (у владельца его нет): успешные + чужие активные резервы; число запусков с повторами
  if v_g.ai_quota is not null then
    select * into v_u from private.grant_usage(v_g.id, v_op);
    select s.attempts_per_generation into v_per from private.access_settings s limit 1;
    if v_u.used + v_u.reserved >= v_g.ai_quota or v_u.starts >= v_g.ai_quota * coalesce(v_per, 3) then
      return jsonb_build_object('result', 'limit_reached', 'access', private.access_state(p_user_id));
    end if;
  end if;

  -- 6. общие лимиты — для всех, включая владельца
  if not v_lim.ai_enabled or v_lim.total_starts >= v_lim.max_total_starts then
    return jsonb_build_object('result', 'ai_paused');
  end if;
  if (select count(*) from private.usage_ledger l
       where l.state = 'reserved' and l.expires_at > pg_catalog.now()
         and not (l.user_id = p_user_id and l.op_key = v_op)) >= v_lim.max_in_flight then
    return jsonb_build_object('result', 'ai_busy');
  end if;

  -- 7. резерв в счёт этой выдачи: новая строка или повтор той же операции (released / просроченный reserved)
  insert into private.usage_ledger as l (user_id, resource, op_key, note_id, state, reserved_at, expires_at, grant_id)
  values (p_user_id, 'text_generation', v_op, p_note_id, 'reserved', pg_catalog.now(),
          pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds), v_g.id)
  on conflict (user_id, resource, op_key) do update
     set state        = 'reserved',
         note_id      = excluded.note_id,
         grant_id     = excluded.grant_id,
         attempts     = l.attempts + 1,
         reserved_at  = excluded.reserved_at,
         expires_at   = excluded.expires_at,
         finalized_at = null
   where l.state <> 'consumed';
  update private.ai_limits set total_starts = total_starts + 1, updated_at = pg_catalog.now() where id;

  -- 8. захват note (итог резерва фиксирует существующий триггер notes_finalize_usage: ready → списан, failed → возвращён)
  update public.notes
     set status = 'processing', stage = 'analyzing', error_code = null, updated_at = pg_catalog.now()
   where id = p_note_id;
  return jsonb_build_object('result', 'started', 'access', private.access_state(p_user_id));
end
$$;

-- -------------------------------------------------------------------------------------
-- 5. Функции владельца (Supabase Dashboard → SQL Editor). Ролям API недоступны.
-- -------------------------------------------------------------------------------------

-- Пользователь по ID участника (KN-XXXXXX). Анонимные аккаунты так не находятся.
create function private.admin_user(p_kn_id text)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_id  text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_kn_id, '')));
  v_uid uuid;
begin
  if v_id !~ '^KN-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$' then
    raise exception 'Неверный ID участника: ожидается KN-XXXXXX' using errcode = '22023';
  end if;
  select u.id into v_uid from auth.users u where u.email = private.kn_email(v_id) and not u.is_anonymous;
  if v_uid is null then
    raise exception 'Участник % не найден', v_id using errcode = 'P0002';
  end if;
  return v_uid;
end
$$;

create function private.admin_lock(p_user_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('konspekt_access:' || p_user_id::text, 0))
$$;

-- Срок и лимит: из тарифа, если не заданы явно.
create function private.admin_terms(p_plan text, p_days integer, p_ai_quota integer)
returns table (plan text, days integer, ai_quota integer)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_p private.plans;
begin
  if p_plan is not null then
    select * into v_p from private.plans p where p.code = p_plan;
    if not found then
      raise exception 'Тариф % не найден в private.plans', p_plan using errcode = 'P0002';
    end if;
  end if;
  plan := p_plan;
  days := coalesce(p_days, v_p.days);
  ai_quota := coalesce(p_ai_quota, v_p.ai_quota);
  if days is null or days not between 1 and 400 then
    raise exception 'Срок доступа: от 1 до 400 дней (задайте p_days или тариф)' using errcode = '22023';
  end if;
  if ai_quota is null or ai_quota not between 0 and 1000 then
    raise exception 'Лимит генераций: от 0 до 1000 (задайте p_ai_quota или тариф)' using errcode = '22023';
  end if;
  return next;
end
$$;

-- Полная картина по участнику: состояние, все выдачи с использованием, старое право, последние записи журнала.
create function private.admin_status(p_kn_id text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := private.admin_user(p_kn_id);
begin
  return jsonb_build_object(
    'kn_id', pg_catalog.upper(pg_catalog.btrim(p_kn_id)),
    'registered_at', (select u.created_at from auth.users u where u.id = v_uid),
    'access', private.access_state(v_uid),
    'grants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'kind', g.kind, 'plan', g.plan, 'starts_at', g.starts_at, 'ends_at', g.ends_at,
               'ai_quota', g.ai_quota, 'ai_used', u.used, 'ai_reserved', u.reserved, 'starts', u.starts,
               'revoked_at', g.revoked_at, 'granted_by', g.granted_by, 'note', g.note) order by g.starts_at, g.created_at)
        from private.access_grants g cross join lateral private.grant_usage(g.id) u
       where g.user_id = v_uid), '[]'::jsonb),
    'legacy', (select jsonb_build_object('source', e.source, 'plan', e.plan, 'quota', e.quota)
                 from private.user_entitlements e where e.user_id = v_uid and e.resource = 'text_generation'),
    'log', coalesce((
      select jsonb_agg(jsonb_build_object('at', x.at, 'action', x.action, 'actor', x.actor, 'details', x.details) order by x.at desc)
        from (select * from private.access_log l where l.user_id = v_uid order by l.at desc limit 20) x), '[]'::jsonb));
end
$$;

-- Первая оплата (или после отзыва): доступ с этого момента. Если уже есть действующий или будущий оплаченный
-- срок — отказ (продление делает admin_extend, чтобы не потерять оплаченное время).
create function private.admin_grant(
  p_kn_id      text,
  p_plan       text    default null,
  p_days       integer default null,
  p_ai_quota   integer default null,
  p_note       text    default null,
  p_granted_by text    default 'owner'
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid uuid := private.admin_user(p_kn_id);
  v_t   record;
  v_end timestamptz;
  v_id  uuid;
begin
  perform private.admin_lock(v_uid);
  select * into v_t from private.admin_terms(p_plan, p_days, p_ai_quota);
  select max(g.ends_at) into v_end
    from private.access_grants g
   where g.user_id = v_uid and g.kind = 'paid' and g.revoked_at is null and g.ends_at > pg_catalog.now();
  if v_end is not null then
    raise exception 'У участника уже оплачен доступ до % — для продления используйте private.admin_extend', v_end
      using errcode = '23505';
  end if;
  insert into private.access_grants (user_id, kind, plan, starts_at, ends_at, ai_quota, granted_by, note)
  values (v_uid, 'paid', v_t.plan, pg_catalog.now(), pg_catalog.now() + pg_catalog.make_interval(days => v_t.days),
          v_t.ai_quota, coalesce(p_granted_by, 'owner'), p_note)
  returning id into v_id;
  insert into private.access_log (action, user_id, grant_id, details)
  values ('grant', v_uid, v_id, jsonb_build_object('plan', v_t.plan, 'days', v_t.days, 'ai_quota', v_t.ai_quota, 'note', p_note));
  return jsonb_build_object('result', 'granted', 'grant_id', v_id, 'status', private.admin_status(p_kn_id));
end
$$;

-- Продление: новый срок начинается с конца последнего оплаченного (если он ещё не закончился) или сейчас.
-- Оплаченное время не теряется; у нового срока свой лимит — остаток прежнего срока не переносится.
create function private.admin_extend(
  p_kn_id      text,
  p_plan       text    default null,
  p_days       integer default null,
  p_ai_quota   integer default null,
  p_note       text    default null,
  p_granted_by text    default 'owner'
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid   uuid := private.admin_user(p_kn_id);
  v_t     record;
  v_start timestamptz;
  v_id    uuid;
begin
  perform private.admin_lock(v_uid);
  select * into v_t from private.admin_terms(p_plan, p_days, p_ai_quota);
  if not exists (select 1 from private.access_grants g where g.user_id = v_uid and g.kind = 'paid') then
    raise exception 'Оплаченного доступа ещё не было — используйте private.admin_grant' using errcode = 'P0002';
  end if;
  select greatest(pg_catalog.now(), coalesce(max(g.ends_at), pg_catalog.now())) into v_start
    from private.access_grants g
   where g.user_id = v_uid and g.kind = 'paid' and g.revoked_at is null;
  insert into private.access_grants (user_id, kind, plan, starts_at, ends_at, ai_quota, granted_by, note)
  values (v_uid, 'paid', v_t.plan, v_start, v_start + pg_catalog.make_interval(days => v_t.days),
          v_t.ai_quota, coalesce(p_granted_by, 'owner'), p_note)
  returning id into v_id;
  insert into private.access_log (action, user_id, grant_id, details)
  values ('extend', v_uid, v_id, jsonb_build_object('plan', v_t.plan, 'days', v_t.days, 'ai_quota', v_t.ai_quota,
                                                    'starts_at', v_start, 'note', p_note));
  return jsonb_build_object('result', 'extended', 'grant_id', v_id, 'starts_at', v_start, 'status', private.admin_status(p_kn_id));
end
$$;

-- Отзыв: действующие и будущие выдачи этого вида помечаются revoked_at (строки и история остаются).
-- p_kind: paid (по умолчанию) | trial | owner. Аккаунт, конспекты и журнал генераций не затрагиваются.
create function private.admin_revoke(
  p_kn_id      text,
  p_note       text default null,
  p_kind       text default 'paid',
  p_granted_by text default 'owner'
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid uuid := private.admin_user(p_kn_id);
  v_n   integer;
begin
  if p_kind is null or p_kind not in ('paid', 'trial', 'owner') then
    raise exception 'p_kind: paid, trial или owner' using errcode = '22023';
  end if;
  perform private.admin_lock(v_uid);
  update private.access_grants g
     set revoked_at = pg_catalog.now()
   where g.user_id = v_uid and g.kind = p_kind and g.revoked_at is null
     and (g.ends_at is null or g.ends_at > pg_catalog.now());
  get diagnostics v_n = row_count;
  insert into private.access_log (action, user_id, details)
  values ('revoke', v_uid, jsonb_build_object('kind', p_kind, 'revoked', v_n, 'note', p_note, 'by', p_granted_by));
  return jsonb_build_object('result', case when v_n > 0 then 'revoked' else 'nothing_to_revoke' end,
                            'revoked', v_n, 'status', private.admin_status(p_kn_id));
end
$$;

-- Постоянный аккаунт владельца: бессрочно, без личного лимита (общие лимиты ai_limits действуют).
-- Только для аккаунта с ID (не анонимного). Существующие анонимные служебные аккаунты не меняются.
create function private.admin_set_owner(p_kn_id text, p_note text default null)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid uuid := private.admin_user(p_kn_id);
  v_id  uuid;
begin
  perform private.admin_lock(v_uid);
  if exists (select 1 from private.access_grants g where g.user_id = v_uid and g.kind = 'owner' and g.revoked_at is null) then
    return jsonb_build_object('result', 'already_owner', 'status', private.admin_status(p_kn_id));
  end if;
  insert into private.access_grants (user_id, kind, starts_at, ends_at, ai_quota, granted_by, note)
  values (v_uid, 'owner', pg_catalog.now(), null, null, 'owner', p_note)
  returning id into v_id;
  insert into private.access_log (action, user_id, grant_id, details)
  values ('set_owner', v_uid, v_id, jsonb_build_object('note', p_note));
  return jsonb_build_object('result', 'owner', 'grant_id', v_id, 'status', private.admin_status(p_kn_id));
end
$$;

-- Механизм будущего переноса (например, участников F&F): пробный период вручную, если его у аккаунта ещё не было.
-- Сейчас не применяется ни к кому.
create function private.admin_grant_trial(p_kn_id text, p_note text default null)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_uid uuid := private.admin_user(p_kn_id);
  v_s   private.access_settings;
  v_id  uuid;
begin
  perform private.admin_lock(v_uid);
  select * into v_s from private.access_settings limit 1;
  insert into private.access_grants (user_id, kind, starts_at, ends_at, ai_quota, granted_by, note)
  values (v_uid, 'trial', pg_catalog.now(), pg_catalog.now() + pg_catalog.make_interval(days => v_s.trial_days),
          v_s.trial_ai_quota, 'owner', p_note)
  on conflict (user_id) where kind = 'trial' do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('result', 'trial_already_used', 'status', private.admin_status(p_kn_id));
  end if;
  insert into private.access_log (action, user_id, grant_id, details)
  values ('grant_trial', v_uid, v_id, jsonb_build_object('days', v_s.trial_days, 'ai_quota', v_s.trial_ai_quota, 'note', p_note));
  return jsonb_build_object('result', 'trial_granted', 'grant_id', v_id, 'status', private.admin_status(p_kn_id));
end
$$;

-- -------------------------------------------------------------------------------------
-- 6. Права
-- -------------------------------------------------------------------------------------
revoke all on function private.active_grant(uuid, timestamptz)              from public, anon, authenticated, service_role;
revoke all on function private.grant_usage(uuid, text)                      from public, anon, authenticated, service_role;
revoke all on function private.access_state(uuid)                           from public, anon, authenticated, service_role;
revoke all on function private.grant_trial_on_register()                    from public, anon, authenticated, service_role;
revoke all on function private.admin_user(text)                             from public, anon, authenticated, service_role;
revoke all on function private.admin_lock(uuid)                             from public, anon, authenticated, service_role;
revoke all on function private.admin_terms(text, integer, integer)          from public, anon, authenticated, service_role;
revoke all on function private.admin_status(text)                           from public, anon, authenticated, service_role;
revoke all on function private.admin_grant(text, text, integer, integer, text, text)  from public, anon, authenticated, service_role;
revoke all on function private.admin_extend(text, text, integer, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function private.admin_revoke(text, text, text, text)         from public, anon, authenticated, service_role;
revoke all on function private.admin_set_owner(text, text)                  from public, anon, authenticated, service_role;
revoke all on function private.admin_grant_trial(text, text)                from public, anon, authenticated, service_role;

revoke all on function public.get_my_access_v2()                            from public, anon, authenticated, service_role;
revoke all on function public.get_plans()                                   from public, anon, authenticated, service_role;
revoke all on function public.start_text_generation_v2(uuid, uuid, integer, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.get_my_access_v2() to authenticated;
grant execute on function public.get_plans()        to authenticated;
grant execute on function public.start_text_generation_v2(uuid, uuid, integer, integer, integer) to service_role;

-- =====================================================================================
-- Откат (вручную, одной транзакцией). Удаляет только объекты этой миграции; выдачи и журнал теряются.
-- Перед откатом вернуть analyze-pages на start_text_generation и клиента на v59/v60.
--
-- begin;
-- drop trigger user_entitlements_trial on private.user_entitlements;
-- drop function public.start_text_generation_v2(uuid, uuid, integer, integer, integer);
-- drop function public.get_my_access_v2();
-- drop function public.get_plans();
-- drop function private.admin_grant_trial(text, text);
-- drop function private.admin_set_owner(text, text);
-- drop function private.admin_revoke(text, text, text, text);
-- drop function private.admin_extend(text, text, integer, integer, text, text);
-- drop function private.admin_grant(text, text, integer, integer, text, text);
-- drop function private.admin_status(text);
-- drop function private.admin_terms(text, integer, integer);
-- drop function private.admin_lock(uuid);
-- drop function private.admin_user(text);
-- drop function private.grant_trial_on_register();
-- drop function private.access_state(uuid);
-- drop function private.grant_usage(uuid, text);
-- drop function private.active_grant(uuid, timestamptz);
-- alter table private.usage_ledger drop column grant_id;
-- drop table private.access_log;
-- drop table private.access_grants;
-- drop table private.plans;
-- drop table private.access_settings;
-- commit;
-- =====================================================================================
