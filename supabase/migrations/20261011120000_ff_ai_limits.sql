-- =====================================================================================
-- Konspekt: Friends & Family — серверные ограничения AI поверх существующего учёта (20261006120000).
--
-- Вторая система квот НЕ создаётся: квота успешных генераций по-прежнему = user_entitlements.quota,
-- учёт — usage_ledger (reserved → consumed | released), итог — триггер notes_finalize_usage.
-- Добавляется одна строка настроек private.ai_limits и проверки в start_text_generation:
--   ai_enabled        — выключатель AI (библиотека и чтение конспектов от него не зависят);
--   max_pages         — не больше стольких страниц в одном запросе (F&F: 4);
--   beta_starts_at /
--   beta_ends_at      — окно F&F для прав, выданных кодом приглашения (source = 'beta_invite'):
--                       вне окна генерация не запускается, get_my_access показывает 0;
--   max_user_starts   — сколько раз всего пользователь F&F (beta_invite) может запустить AI,
--                       включая неудачные попытки и повторы: неудачи квоту успешных не тратят,
--                       но и не дают бесконечных платных повторов;
--   max_total_starts /
--   total_starts      — глобальный счётчик запусков AI (все пользователи, включая ручные права).
--                       Запуск считается в момент старта, поэтому идущие запросы уже учтены;
--   max_in_flight     — сколько генераций может идти одновременно (активные резервы).
--
-- Значения по умолчанию безопасные: max_total_starts = 0 — AI не запустится, пока владелец
-- явно не задаст бюджет запусков (см. supabase/README.md, раздел F&F). Применять только вручную.
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- 1. Настройки (одна строка)
-- -------------------------------------------------------------------------------------

create table private.ai_limits (
  id               boolean     primary key default true check (id),
  ai_enabled       boolean     not null default true,
  max_pages        integer     not null default 4 check (max_pages between 1 and 8),
  beta_starts_at   timestamptz not null,
  beta_ends_at     timestamptz not null,
  max_user_starts  integer     not null default 3 check (max_user_starts >= 1),
  max_total_starts integer     not null default 0 check (max_total_starts >= 0),
  total_starts     integer     not null default 0 check (total_starts >= 0),
  max_in_flight    integer     not null default 3 check (max_in_flight >= 1),
  updated_at       timestamptz not null default now(),
  constraint ai_limits_window_check check (beta_ends_at > beta_starts_at)
);

-- F&F: 2026-10-12 00:00 — 2026-10-19 00:00 по Москве (верхняя граница не входит)
insert into private.ai_limits (beta_starts_at, beta_ends_at)
values ('2026-10-12 00:00:00+03', '2026-10-19 00:00:00+03');

alter table private.ai_limits enable row level security;
revoke all on private.ai_limits from public, anon, authenticated, service_role;


-- -------------------------------------------------------------------------------------
-- 2. Права F&F действуют только в окне
-- -------------------------------------------------------------------------------------

-- Действует ли право сейчас: ручные права (владелец, тесты) — всегда; по коду приглашения — только в окне F&F.
create function private.entitlement_active(p_source text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_source <> 'beta_invite'
      or exists (select 1 from private.ai_limits s
                  where pg_catalog.now() >= s.beta_starts_at and pg_catalog.now() < s.beta_ends_at)
$$;

-- Вне окна F&F: remaining и available = 0 (клиент покажет «закончились»); сигнатура и столбцы прежние.
create or replace function public.get_my_access()
returns table (resource text, plan text, quota integer, used integer, reserved integer, remaining integer, available integer)
language sql
stable
security definer
set search_path = ''
as $$
  select e.resource, e.plan, e.quota, c.used, c.reserved,
         case when private.entitlement_active(e.source) then greatest(e.quota - c.used, 0) else 0 end,
         case when private.entitlement_active(e.source) then greatest(e.quota - c.used - c.reserved, 0) else 0 end
  from private.user_entitlements e
  cross join lateral private.usage_counts(e.user_id, e.resource) c
  where e.user_id = auth.uid()
$$;


-- -------------------------------------------------------------------------------------
-- 3. start_text_generation: те же шаги + число страниц, окно F&F, лимиты запусков
-- -------------------------------------------------------------------------------------
-- Новые результаты (AI не запускается, резерв и счётчики не меняются):
--   too_many_pages — страниц больше max_pages;
--   access_expired — право по коду приглашения вне окна F&F;
--   ai_paused      — AI выключен или исчерпан глобальный бюджет запусков;
--   ai_busy        — уже идёт max_in_flight генераций;
--   limit_reached  — как раньше, а также исчерпан max_user_starts пользователя F&F.
-- p_page_count = null — вызов прежней версии analyze-pages (v19, проверяет ≤ 8 сама): число страниц
-- здесь не проверяется, остальные лимиты — да. Новая версия функции всегда передаёт число страниц.
-- Порядок блокировок: note → право пользователя → настройки → строка журнала (триггер: note → журнал).

drop function public.start_text_generation(uuid, uuid, integer, integer);

create function public.start_text_generation(
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
  v_note     record;
  v_ent      record;
  v_lim      record;
  v_state    text;
  v_used     integer;
  v_reserved integer;
  v_starts   integer;
  v_op       text := p_note_id::text;
begin
  if p_user_id is null or p_note_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if p_stale_seconds is null or p_lease_seconds is null
     or p_stale_seconds not between 60 and 3600 or p_lease_seconds not between 60 and 3600
     or (p_page_count is not null and p_page_count < 1) then
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
  select e.quota, e.source into v_ent
    from private.user_entitlements e
   where e.user_id = p_user_id and e.resource = 'text_generation'
     for update;
  if not found then
    return jsonb_build_object('result', 'no_access');
  end if;

  -- 3. настройки: все запуски AI — строго по очереди (глобальный счётчик и число идущих генераций)
  select * into v_lim from private.ai_limits for update;
  if not found then
    return jsonb_build_object('result', 'ai_paused');
  end if;
  if p_page_count is not null and p_page_count > v_lim.max_pages then
    return jsonb_build_object('result', 'too_many_pages', 'max_pages', v_lim.max_pages);
  end if;
  if not private.entitlement_active(v_ent.source) then
    return jsonb_build_object('result', 'access_expired', 'access', private.access_json(p_user_id, 'text_generation'));
  end if;

  select l.state into v_state
    from private.usage_ledger l
   where l.user_id = p_user_id and l.resource = 'text_generation' and l.op_key = v_op;
  if v_state = 'consumed' then
    return jsonb_build_object('result', 'already_consumed', 'access', private.access_json(p_user_id, 'text_generation'));
  end if;

  -- 4. лимит успешных: успешные + чужие активные резервы (свой прежний резерв этой же note не считается)
  select c.used, c.reserved into v_used, v_reserved
    from private.usage_counts(p_user_id, 'text_generation', v_op) c;
  -- лимит запусков пользователя F&F: все попытки (attempts) по всем его операциям
  select coalesce(sum(l.attempts), 0)::integer into v_starts
    from private.usage_ledger l
   where l.user_id = p_user_id and l.resource = 'text_generation';
  if v_used + v_reserved >= v_ent.quota
     or (v_ent.source = 'beta_invite' and v_starts >= v_lim.max_user_starts) then
    update private.user_entitlements
       set blocked_attempts = blocked_attempts + 1, last_blocked_at = pg_catalog.now(), updated_at = pg_catalog.now()
     where user_id = p_user_id and resource = 'text_generation';
    return jsonb_build_object('result', 'limit_reached', 'access', private.access_json(p_user_id, 'text_generation'));
  end if;

  -- 5. глобальные лимиты: выключатель, бюджет запусков, одновременные генерации (кроме своей прежней)
  if not v_lim.ai_enabled or v_lim.total_starts >= v_lim.max_total_starts then
    return jsonb_build_object('result', 'ai_paused');
  end if;
  if (select count(*) from private.usage_ledger l
       where l.state = 'reserved' and l.expires_at > pg_catalog.now()
         and not (l.user_id = p_user_id and l.op_key = v_op)) >= v_lim.max_in_flight then
    return jsonb_build_object('result', 'ai_busy');
  end if;

  -- 6. резерв: новая строка или повтор той же операции (released / просроченный reserved)
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

  update private.ai_limits set total_starts = total_starts + 1, updated_at = pg_catalog.now();

  -- 7. захват note (как в v18)
  update public.notes
     set status = 'processing', stage = 'analyzing', error_code = null, updated_at = pg_catalog.now()
   where id = p_note_id;

  return jsonb_build_object('result', 'started', 'access', private.access_json(p_user_id, 'text_generation'));
end
$$;


-- -------------------------------------------------------------------------------------
-- 4. Права на функции
-- -------------------------------------------------------------------------------------

revoke all on function
  private.entitlement_active(text),
  public.get_my_access(),
  public.start_text_generation(uuid, uuid, integer, integer, integer)
from public, anon, authenticated, service_role;

grant execute on function public.get_my_access()                                             to authenticated;
grant execute on function public.start_text_generation(uuid, uuid, integer, integer, integer) to service_role;


-- -------------------------------------------------------------------------------------
-- Управление (SQL Editor, владелец):
--   задать бюджет запусков:  update private.ai_limits set max_total_starts = <N>, updated_at = now();
--   выключить AI:            update private.ai_limits set ai_enabled = false, updated_at = now();
--   состояние:               select * from private.ai_limits;
--
-- Откат (вручную): вернуть start_text_generation и get_my_access из 20261006120000 (drop новой
-- сигнатуры, create прежней, revoke/grant как там), затем
--   drop function private.entitlement_active(text); drop table private.ai_limits;
-- -------------------------------------------------------------------------------------
