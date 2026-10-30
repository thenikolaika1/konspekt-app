-- =====================================================================================
-- Konspekt v62: платная библиотека, тариф Premium, резерв бюджета ИИ под оплаченные генерации.
--
-- Применять ПОСЛЕ 20261024150000_paid_access.sql и 20261026120000_owner_panel.sql, одним запуском (одна транзакция).
-- Повторный запуск ничего не меняет: проверка в начале останавливает его, если v62 уже применена.
-- Аккаунты, личные конспекты, выдачи доступа, журнал генераций, аналитика и лимиты ИИ не меняются: max_total_starts
-- и total_starts остаются как были (бюджет владелец меняет сам — public.owner_set_budget).
--
-- 1. Тексты готовых конспектов библиотеки — в закрытой таблице private.library_paragraphs (ролям API недоступна).
--    Читать их можно только через public.get_library_paragraph (POST, пользователь — только из JWT): владелец,
--    действующий пробный период или оплаченный доступ (private.access_state; срок — по часам сервера).
--    Сами тексты эта миграция не загружает: их заливает отдельный файл, который генерирует
--    tools/library-split.mjs из исходного каталога, хранящегося вне публичного репозитория.
-- 2. Тариф premium: Premium, 30 дней, 10 успешных генераций, «299 ₽». Панель выдаёт и продлевает доступ по нему;
--    другие условия — только с явным подтверждением владельца (p_custom).
-- 3. Резерв бюджета ИИ (единица — запуск ИИ). O — оставшиеся успешные генерации действующих и уже оплаченных будущих
--    сроков (kind = paid); резерв R = ceil(O × k), k = access_settings.budget_reserve_factor (1.5). Запуск для
--    оплаченного срока разрешён, пока общий бюджет не исчерпан; владельцу — пока остаётся резерв R; пробному периоду и
--    старым аккаунтам — пока остаются R и резерв владельца (owner_reserve_starts запусков за 30 дней, сколько он ещё
--    не потратил). Иначе — ai_paused (его понимает analyze-pages, deploy функции не нужен).
--    k — оценочный запас на неудачи и повторы, а не гарантия: при большом числе технических ошибок бюджет может
--    закончиться раньше, тогда его увеличивает владелец.
--    Новая выдача или продление в панели проверяют, что свободного бюджета хватает на ceil(лимит × k) запусков.
-- Порядок блокировок (как в v61): note (FOR UPDATE) → advisory пользователя → строка private.ai_limits (FOR UPDATE).
--   Выдача в панели: advisory пользователя → private.ai_limits. Изменение бюджета: только private.ai_limits.
-- Откат — в конце файла.
-- =====================================================================================

begin;
-- не ждать чужих блокировок дольше 5 с: если таблицу или функцию держит работающий запрос (например, генерация),
-- миграция откатится целиком, а не встанет в очередь и не задержит учеников; тогда просто запустить её ещё раз
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.owner_preview(text, text, text, integer, integer)') is null
     or to_regclass('private.access_grants') is null then
    raise exception 'Сначала примените 20261024150000_paid_access.sql и 20261026120000_owner_panel.sql';
  end if;
  if to_regclass('private.library_paragraphs') is not null
     or to_regprocedure('private.start_text_generation_v2_base(uuid, uuid, integer, integer, integer)') is not null then
    raise exception 'v62 уже применена — повторный запуск ничего не меняет';
  end if;
  if exists (select 1 from private.plans p where p.active and p.code <> 'premium') then
    raise exception 'В private.plans уже есть другой активный тариф — v62 рассчитана на единственный тариф premium';
  end if;
end $$;

-- -------------------------------------------------------------------------------------
-- 1. Настройки резерва (одна строка private.access_settings)
-- -------------------------------------------------------------------------------------

alter table private.access_settings
  add column budget_reserve_factor numeric(4,2) not null default 1.5 check (budget_reserve_factor between 1 and 5),
  add column owner_reserve_starts  integer      not null default 10  check (owner_reserve_starts between 0 and 1000),
  add column budget_warn_percent   integer      not null default 20  check (budget_warn_percent between 1 and 90);

-- -------------------------------------------------------------------------------------
-- 2. Библиотека: закрытые тексты и выдача с проверкой доступа
-- -------------------------------------------------------------------------------------

create table private.library_paragraphs (
  subject_id   text        not null check (subject_id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  book_id      text        not null check (book_id ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  paragraph_id text        not null check (paragraph_id ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  content      jsonb       not null check (pg_catalog.jsonb_typeof(content) = 'object'),
  updated_at   timestamptz not null default now(),
  primary key (subject_id, book_id, paragraph_id)
);
alter table private.library_paragraphs enable row level security;
revoke all on private.library_paragraphs from public, anon, authenticated, service_role;

-- Готовый конспект библиотеки. Ответ — всегда объект: { content } или { error }; текст — только с доступом.
--   METHOD_NOT_ALLOWED — не POST (GET мог бы осесть в кэшах по адресу); UNAUTHORIZED — нет входа;
--   ACCESS_REQUIRED (+ access — состояние доступа для экрана) — нет владельца, пробного периода или оплаты;
--   NOT_FOUND — нет такого конспекта (или неверный формат id; подробностей нет).
-- Пользователь — только auth.uid() (из подписанного JWT): параметров с id пользователя у функции нет.
create function public.get_library_paragraph(p_subject text, p_book text, p_paragraph text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_a   jsonb;
  v_c   jsonb;
begin
  if not private.panel_post_only() then
    return jsonb_build_object('error', 'METHOD_NOT_ALLOWED');
  end if;
  if v_uid is null then
    return jsonb_build_object('error', 'UNAUTHORIZED');
  end if;
  v_a := private.access_state(v_uid);
  if coalesce(v_a ->> 'status', 'none') not in ('owner', 'paid', 'trial') then
    return jsonb_build_object('error', 'ACCESS_REQUIRED', 'access', v_a);
  end if;
  if p_subject is null or p_book is null or p_paragraph is null
     or p_subject !~ '^[a-z0-9][a-z0-9-]{0,39}$' or p_book !~ '^[a-z0-9][a-z0-9-]{0,99}$'
     or p_paragraph !~ '^[a-z0-9][a-z0-9-]{0,99}$' then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  select l.content into v_c
    from private.library_paragraphs l
   where l.subject_id = p_subject and l.book_id = p_book and l.paragraph_id = p_paragraph;
  if v_c is null then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  return jsonb_build_object('content', v_c, 'access_status', v_a ->> 'status');
end
$$;

-- -------------------------------------------------------------------------------------
-- 3. Тариф Premium (единственный)
-- -------------------------------------------------------------------------------------

insert into private.plans (code, title, days, ai_quota, price_label, description, active, sort_order)
values ('premium', 'Premium', 30, 10, '299 ₽',
        'История и физика целиком, 10 конспектов по фото за 30 дней', true, 10)
on conflict (code) do update set active = true, updated_at = pg_catalog.now()
 where plans.title = 'Premium' and plans.days = 30 and plans.ai_quota = 10 and plans.price_label = '299 ₽'
   and not plans.active;   -- тот же тариф, выключенный откатом v62: включить снова; с другими условиями — не трогать

do $$
begin
  if not exists (select 1 from private.plans p
                  where p.code = 'premium' and p.title = 'Premium' and p.days = 30 and p.ai_quota = 10
                    and p.price_label = '299 ₽' and p.active) then
    raise exception 'Тариф premium уже есть в private.plans с другими условиями — проверьте его вручную';
  end if;
end $$;

-- Пометка подарочного доступа (не продаётся: active = false, get_plans её не показывает). Подарок — срок kind = 'paid'
-- с plan = 'gift': библиотека и ИИ как у оплаченного срока, но это не покупка Premium (см. раздел 5б).
insert into private.plans (code, title, days, ai_quota, price_label, description, active, sort_order)
values ('gift', 'Подарок', 7, 1, null, 'Подарочный доступ от владельца: история, физика и ИИ по фото на выбранный срок', false, 90)
on conflict (code) do nothing;

do $$
begin
  if not exists (select 1 from private.plans p where p.code = 'gift' and p.title = 'Подарок' and not p.active) then
    raise exception 'Код gift в private.plans уже занят другим тарифом — проверьте его вручную';
  end if;
end $$;

-- -------------------------------------------------------------------------------------
-- 4. Бюджет ИИ: обязательства по оплаченным срокам и резерв
-- -------------------------------------------------------------------------------------

-- O: оставшиеся успешные генерации действующих и будущих оплаченных сроков (без идущих сейчас резервов:
-- их запуск уже учтён в total_starts). Подарки (plan = 'gift') не входят: резерв защищает только оплаченное.
create function private.premium_obligations()
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(greatest(g.ai_quota - u.used - u.reserved, 0)), 0)::integer
    from private.access_grants g cross join lateral private.grant_usage(g.id) u
   where g.kind = 'paid' and g.plan is distinct from 'gift' and g.revoked_at is null and g.ends_at > pg_catalog.now()
$$;

-- Обещанные подарочные генерации (действующие и будущие подарки): НЕ резерв — подарочные запуски идут только сверх
-- резерва Premium; учитываются лишь при выдаче нового подарка, чтобы не обещать больше, чем есть свободного бюджета.
create function private.gift_obligations()
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(greatest(g.ai_quota - u.used - u.reserved, 0)), 0)::integer
    from private.access_grants g cross join lateral private.grant_usage(g.id) u
   where g.kind = 'paid' and g.plan = 'gift' and g.revoked_at is null and g.ends_at > pg_catalog.now()
$$;

-- Сколько запусков из резерва владельца на 30 дней он ещё не потратил.
create function private.owner_reserve_left()
returns integer
language sql
stable
set search_path = ''
as $$
  select greatest(c.owner_reserve_starts
                  - (select count(*) from private.generation_starts s
                      where s.started_at > pg_catalog.now() - interval '30 days'
                        and exists (select 1 from private.access_grants g
                                     where g.user_id = s.user_id and g.kind = 'owner' and g.revoked_at is null)), 0)::integer
    from private.access_settings c
$$;

-- Состояние бюджета: всего, израсходовано, обязательства, резервы, свободно, предупреждение.
create function private.budget_state()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_l    record;
  v_c    private.access_settings;
  v_o    integer := private.premium_obligations();
  v_r    integer;
  v_own  integer := private.owner_reserve_left();
  v_rem  integer;
  v_free integer;
  v_per  integer;
  v_plan integer;
begin
  select * into v_l from private.ai_limits limit 1;
  select * into v_c from private.access_settings limit 1;
  v_r := ceil(v_o * v_c.budget_reserve_factor)::integer;
  v_rem := greatest(v_l.max_total_starts - v_l.total_starts, 0);
  v_free := v_rem - v_r - v_own;
  select p.ai_quota into v_plan from private.plans p where p.code = 'premium' and p.active;
  v_per := ceil(coalesce(v_plan, 10) * v_c.budget_reserve_factor)::integer;
  return jsonb_build_object(
    'budget', v_l.max_total_starts, 'used', v_l.total_starts, 'remaining', v_rem,
    'obligations', v_o, 'factor', v_c.budget_reserve_factor, 'premium_reserve', v_r,
    'owner_reserve', v_c.owner_reserve_starts, 'owner_reserve_left', v_own,
    'free', v_free, 'per_premium', v_per, 'can_sell', greatest(v_free, 0) / greatest(v_per, 1),
    'min_budget', v_l.total_starts + v_r,
    'gift_obligations', private.gift_obligations(),
    'warn_percent', v_c.budget_warn_percent,
    'state', case when v_rem <= 0 then 'exhausted'
                  when v_free <= 0 then 'reserved_only'
                  when v_free * 100 < v_l.max_total_starts * v_c.budget_warn_percent then 'low'
                  else 'ok' end);
end
$$;

-- Проверка запуска: прежняя функция (без изменений) работает как основа, новая проверяет резерв после её
-- решения «started» — под той же блокировкой строки ai_limits; отказ откатывает весь запуск (резерв, счётчик,
-- журнал запусков, захват note) и возвращает ai_paused.
alter function public.start_text_generation_v2(uuid, uuid, integer, integer, integer) rename to start_text_generation_v2_base;
alter function public.start_text_generation_v2_base(uuid, uuid, integer, integer, integer) set schema private;
revoke all on function private.start_text_generation_v2_base(uuid, uuid, integer, integer, integer)
  from public, anon, authenticated, service_role;

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
  v_r    jsonb;
  v_kind text;
  v_plan text;
  v_l    record;
  v_c    private.access_settings;
  v_need integer;
begin
  begin
    v_r := private.start_text_generation_v2_base(p_user_id, p_note_id, p_stale_seconds, p_lease_seconds, p_page_count);
    if v_r ->> 'result' = 'started' then
      select g.kind, g.plan into v_kind, v_plan from private.active_grant(p_user_id) g;
      -- оплаченный срок — резерв и есть его генерации; подарок, пробный, владелец и прочие — только сверх резерва
      if v_kind is distinct from 'paid' or v_plan = 'gift' then
        -- строка ai_limits уже заблокирована основой в этой транзакции; запуск в total_starts уже учтён
        select * into v_l from private.ai_limits for update;
        select * into v_c from private.access_settings limit 1;
        v_need := ceil(private.premium_obligations() * v_c.budget_reserve_factor)::integer
                  + case when v_kind = 'owner' then 0 else private.owner_reserve_left() end;
        if v_l.max_total_starts - v_l.total_starts < v_need then
          raise exception 'premium_reserve' using errcode = 'KN030';
        end if;
      end if;
    end if;
    return v_r;
  exception when sqlstate 'KN030' then
    return jsonb_build_object('result', 'ai_paused', 'reason', 'premium_reserve');
  end;
end
$$;

-- Состояние ИИ для панели: прежнее + бюджет с резервами.
alter function private.panel_ai_state() rename to panel_ai_state_base;

create function private.panel_ai_state()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.panel_ai_state_base() || jsonb_build_object('reserve', private.budget_state())
$$;

-- -------------------------------------------------------------------------------------
-- 5. Панель: Premium по умолчанию, подтверждение других условий, проверка бюджета, изменение бюджета
-- -------------------------------------------------------------------------------------

create or replace function private.panel_error(p_state text, p_message text)
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
                        when 'KN031' then 'CUSTOM_TERMS_NOT_CONFIRMED'
                        else 'SERVER_ERROR' end,
           'message', case when p_state in ('22023', 'P0002', '23505', '23514') then p_message end)
$$;

-- Условия выдачи: тариф premium (если активен) и явные дни/лимит поверх него (не заданы — из тарифа).
-- custom — условия отличаются от тарифа: такую выдачу панель делает только с p_custom = true, и она записывается
-- без тарифа (plan NULL), чтобы «Premium» в карточке ученика всегда означал 30 дней и 10 генераций.
create function private.panel_terms(p_days integer, p_ai_quota integer,
                                    out o_plan text, out o_days integer, out o_quota integer, out o_custom boolean)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_p private.plans;
  v_t record;
begin
  select * into v_p from private.plans p where p.code = 'premium' and p.active;
  select * into v_t from private.admin_terms(v_p.code, p_days, p_ai_quota);
  o_days := v_t.days;
  o_quota := v_t.ai_quota;
  o_custom := v_p.code is null or o_days <> v_p.days or o_quota <> v_p.ai_quota;
  o_plan := case when o_custom then null else v_p.code end;
end
$$;

-- Хватит ли свободного бюджета на новый срок с лимитом p_quota. Вызывать под блокировкой строки ai_limits.
create function private.panel_budget_check(p_quota integer)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_b    jsonb := private.budget_state();
  v_need integer;
begin
  v_need := ceil(p_quota * (v_b ->> 'factor')::numeric)::integer;
  return jsonb_build_object('need', v_need, 'free', (v_b ->> 'free')::integer, 'ok', (v_b ->> 'free')::integer >= v_need,
                            'budget', v_b);
end
$$;

-- Хватит ли свободного бюджета на подарок с p_quota генерациями: свободное за вычетом уже обещанных подарков (× k).
-- Вызывать под блокировкой строки ai_limits при выдаче.
create function private.panel_gift_budget_check(p_quota integer)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_b    jsonb := private.budget_state();
  v_k    numeric := (v_b ->> 'factor')::numeric;
  v_need integer := ceil(p_quota * v_k)::integer;
  v_free integer := (v_b ->> 'free')::integer - ceil((v_b ->> 'gift_obligations')::integer * v_k)::integer;
begin
  return jsonb_build_object('need', v_need, 'free', v_free, 'ok', v_free >= v_need, 'budget', v_b);
end
$$;

create or replace function public.owner_preview(p_session text, p_kn_id text, p_action text, p_days integer default null,
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
  v_g     record;
  v_a     jsonb;
begin
  if not private.panel_post_only() then
    return jsonb_build_object('error', 'METHOD_NOT_ALLOWED');
  end if;
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
  if p_action = 'gift' then
    begin
      select * into v_g from private.panel_gift_plan(v_uid, p_days, p_ai_quota);
    exception
      when numeric_value_out_of_range or datetime_field_overflow then
        return jsonb_build_object('error', 'GIFT_TOO_LARGE');
      when others then
        return private.panel_error(sqlstate, sqlerrm);
    end;
    if v_g.o_err is not null then
      return jsonb_build_object('error', v_g.o_err);
    end if;
    v_a := private.access_state(v_uid);
    return jsonb_build_object(
      'action', 'gift', 'kn_id', v_kn, 'days', p_days, 'ai_quota', p_ai_quota,
      'merge', v_g.o_merge is not null, 'starts_at', v_g.o_starts, 'ends_at', v_g.o_ends, 'total_quota', v_g.o_quota,
      'starts_after_current', v_g.o_starts > pg_catalog.now() + interval '1 second',
      'trial_active', v_a ->> 'status' = 'trial' and v_a ->> 'kind' = 'trial',
      'budget_check', private.panel_gift_budget_check(p_ai_quota),
      'periods', v_per, 'access', v_a, 'server_now', pg_catalog.now());
  end if;
  if p_action not in ('grant', 'extend') then
    return jsonb_build_object('error', 'INVALID_INPUT');
  end if;
  begin
    select * into v_t from private.panel_terms(p_days, p_ai_quota);
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
    'action', p_action, 'kn_id', v_kn, 'days', v_t.o_days, 'ai_quota', v_t.o_quota,
    'plan', v_t.o_plan, 'custom', v_t.o_custom,
    'starts_at', v_start, 'ends_at', v_start + pg_catalog.make_interval(days => v_t.o_days),
    -- продление встык к действующему сроку; иначе — с момента подтверждения
    'starts_after_current', v_start > pg_catalog.now() + interval '1 second',
    'budget_check', private.panel_budget_check(v_t.o_quota),
    'periods', v_per, 'access', private.access_state(v_uid), 'server_now', pg_catalog.now());
end
$$;

drop function public.owner_grant(text, uuid, text, integer, integer, text);
drop function public.owner_extend(text, uuid, text, integer, integer, text, timestamptz);

create function public.owner_grant(p_session text, p_request_id uuid, p_kn_id text, p_days integer, p_ai_quota integer,
                                   p_note text default null, p_custom boolean default false)
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
  v_m   record;
  v_b   jsonb;
  v_r   jsonb;
  v_g   jsonb;
begin
  if not private.panel_post_only() then
    return jsonb_build_object('error', 'METHOD_NOT_ALLOWED');
  end if;
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  v_r := private.panel_request(p_request_id, v_c.o_uid, 'grant',
           jsonb_build_object('kn', p_kn_id, 'days', p_days, 'ai_quota', p_ai_quota, 'note', p_note,
                              'custom', coalesce(p_custom, false)));
  if v_r is not null then
    return v_r;
  end if;
  begin
    select * into v_t from private.panel_target(p_kn_id);
    v_uid := v_t.o_uid;
    select * into v_m from private.panel_terms(p_days, p_ai_quota);
    if v_m.o_custom and not coalesce(p_custom, false) then
      raise exception 'CUSTOM_TERMS_NOT_CONFIRMED' using errcode = 'KN031';
    end if;
    perform private.admin_lock(v_t.o_uid);
    perform 1 from private.ai_limits for update;
    v_b := private.panel_budget_check(v_m.o_quota);
    if not (v_b ->> 'ok')::boolean then
      v_r := jsonb_build_object('error', 'BUDGET_LOW', 'need', v_b -> 'need', 'free', v_b -> 'free');
    else
      v_g := private.admin_grant(v_t.o_kn, v_m.o_plan, v_m.o_days, v_m.o_quota, nullif(pg_catalog.btrim(p_note), ''),
                                 'panel:' || v_c.o_kn);
      v_r := jsonb_build_object('result', 'granted', 'kn_id', v_t.o_kn,
               'grant', (select jsonb_build_object('starts_at', g.starts_at, 'ends_at', g.ends_at, 'ai_quota', g.ai_quota,
                                                   'plan', g.plan)
                           from private.access_grants g where g.id = (v_g ->> 'grant_id')::uuid),
               'access', private.access_state(v_t.o_uid));
    end if;
  exception when others then
    v_r := private.panel_error(sqlstate, sqlerrm);
  end;
  if v_r ? 'error' then
    perform private.panel_refused(v_uid, 'grant', v_r);
  end if;
  return private.panel_request_done(p_request_id, v_r);
end
$$;

create function public.owner_extend(p_session text, p_request_id uuid, p_kn_id text, p_days integer, p_ai_quota integer,
                                    p_note text default null, p_expect_starts_at timestamptz default null,
                                    p_custom boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c     record;
  v_uid   uuid;
  v_t     record;
  v_m     record;
  v_b     jsonb;
  v_r     jsonb;
  v_g     jsonb;
  v_start timestamptz;
begin
  if not private.panel_post_only() then
    return jsonb_build_object('error', 'METHOD_NOT_ALLOWED');
  end if;
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  v_r := private.panel_request(p_request_id, v_c.o_uid, 'extend',
           jsonb_build_object('kn', p_kn_id, 'days', p_days, 'ai_quota', p_ai_quota, 'note', p_note, 'expect', p_expect_starts_at,
                              'custom', coalesce(p_custom, false)));
  if v_r is not null then
    return v_r;
  end if;
  begin
    select * into v_t from private.panel_target(p_kn_id);
    v_uid := v_t.o_uid;
    select * into v_m from private.panel_terms(p_days, p_ai_quota);
    if v_m.o_custom and not coalesce(p_custom, false) then
      raise exception 'CUSTOM_TERMS_NOT_CONFIRMED' using errcode = 'KN031';
    end if;
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
    perform 1 from private.ai_limits for update;
    v_b := private.panel_budget_check(v_m.o_quota);
    if not (v_b ->> 'ok')::boolean then
      v_r := jsonb_build_object('error', 'BUDGET_LOW', 'need', v_b -> 'need', 'free', v_b -> 'free');
    else
      v_g := private.admin_extend(v_t.o_kn, v_m.o_plan, v_m.o_days, v_m.o_quota, nullif(pg_catalog.btrim(p_note), ''),
                                  'panel:' || v_c.o_kn);
      v_r := jsonb_build_object('result', 'extended', 'kn_id', v_t.o_kn,
               'grant', (select jsonb_build_object('starts_at', g.starts_at, 'ends_at', g.ends_at, 'ai_quota', g.ai_quota,
                                                   'plan', g.plan)
                           from private.access_grants g where g.id = (v_g ->> 'grant_id')::uuid),
               'access', private.access_state(v_t.o_uid));
    end if;
  exception when others then
    v_r := private.panel_error(sqlstate, sqlerrm);
  end;
  if v_r ? 'error' then
    perform private.panel_refused(v_uid, 'extend', v_r);
  end if;
  return private.panel_request_done(p_request_id, v_r);
end
$$;

-- Изменение общего бюджета ИИ владельцем. p_expect_budget — бюджет, который владелец видел (защита от двойного
-- изменения); новое значение не ниже израсходованного + резерва оплаченных генераций и не больше 100 000.
create function public.owner_set_budget(p_session text, p_request_id uuid, p_new_budget integer, p_expect_budget integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c   record;
  v_r   jsonb;
  v_l   record;
  v_b   jsonb;
  v_min integer;
begin
  if not private.panel_post_only() then
    return jsonb_build_object('error', 'METHOD_NOT_ALLOWED');
  end if;
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  v_r := private.panel_request(p_request_id, v_c.o_uid, 'budget',
           jsonb_build_object('new', p_new_budget, 'expect', p_expect_budget));
  if v_r is not null then
    return v_r;
  end if;
  select * into v_l from private.ai_limits for update;
  v_b := private.budget_state();
  v_min := (v_b ->> 'min_budget')::integer;
  if p_new_budget is null or p_expect_budget is null or p_new_budget not between 0 and 100000 then
    v_r := jsonb_build_object('error', 'INVALID_INPUT');
  elsif p_expect_budget <> v_l.max_total_starts then
    v_r := jsonb_build_object('error', 'STATE_CHANGED');
  elsif p_new_budget < v_min then
    v_r := jsonb_build_object('error', 'BUDGET_TOO_LOW', 'min', v_min);
  else
    update private.ai_limits set max_total_starts = p_new_budget, updated_at = pg_catalog.now() where id;
    insert into private.access_log (action, user_id, details)
    values ('budget', null, jsonb_build_object('from', v_l.max_total_starts, 'to', p_new_budget, 'used', v_l.total_starts,
                                               'premium_reserve', v_b -> 'premium_reserve'));
    v_r := jsonb_build_object('result', 'budget_set', 'budget', p_new_budget, 'ai', private.panel_ai_state());
  end if;
  if v_r ? 'error' then
    perform private.panel_refused(null, 'budget', v_r);
  end if;
  return private.panel_request_done(p_request_id, v_r);
end
$$;

-- -------------------------------------------------------------------------------------
-- 5б. Подарочный доступ («🎁 Подарить доступ» в панели)
-- -------------------------------------------------------------------------------------
-- Подарок — срок kind = 'paid' с plan = 'gift'. Даёт то же, что оплаченный срок: историю и физику целиком и ИИ по фото
-- в пределах подаренного числа генераций, по времени сервера. Но это не покупка Premium:
--   - не входит в обязательства бюджета (резерв Premium его не защищает): при нехватке свободного бюджета подарочные
--     запуски ставятся на паузу, как пробные; оплаченные генерации идут первыми;
--   - новый подарок выдаётся, только если свободного бюджета (за вычетом уже обещанных подарков × k) хватает на
--     ceil(генерации × k): подарков не обещают больше, чем есть; Premium продаётся без учёта подарков (он важнее);
--   - в статистике панели («с подпиской», «истекают») не считается подпиской;
--   - пробный период не меняет и не запускает заново.
-- Повторный подарок: если последний (по окончанию) действующий или будущий срок ученика — подарок, новый подарок
-- ДОБАВЛЯЕТСЯ к нему (дни к сроку, генерации к лимиту); иначе — новый срок с конца последнего оплаченного (действующий
-- Premium не сокращается и не меняется) или с текущего момента. Владельцу и аккаунтам с особым ручным доступом подарок
-- не выдаётся (их доступ не меняется). Технические пределы: 1–3650 дней и 1–1000 генераций за раз, итог подарочного
-- срока — не больше 1000 генераций и не дальше 3650 дней от сегодня.

-- План подарка: что будет сделано (без изменений). Вызывать под блокировкой пользователя (admin_lock) при выдаче.
create function private.panel_gift_plan(p_user_id uuid, p_days integer, p_ai_quota integer,
                                        out o_err text, out o_merge uuid, out o_starts timestamptz,
                                        out o_ends timestamptz, out o_quota integer)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_a    jsonb;
  v_last private.access_grants;
begin
  if p_days is null or p_ai_quota is null or p_days not between 1 and 3650 or p_ai_quota not between 1 and 1000 then
    o_err := 'GIFT_INVALID';
    return;
  end if;
  v_a := private.access_state(p_user_id);
  if v_a ->> 'status' = 'owner' then
    o_err := 'GIFT_OWNER';
    return;
  end if;
  if v_a ->> 'kind' = 'legacy' and v_a ->> 'status' in ('paid', 'trial') then
    o_err := 'GIFT_MANUAL_ACCESS';   -- особый ручной доступ без выдач: подарок заменил бы его, не трогаем
    return;
  end if;
  select * into v_last
    from private.access_grants g
   where g.user_id = p_user_id and g.kind = 'paid' and g.revoked_at is null and g.ends_at > pg_catalog.now()
   order by g.ends_at desc, g.created_at desc
   limit 1;
  if v_last.id is not null and v_last.plan = 'gift' then
    o_merge := v_last.id;
    o_starts := v_last.starts_at;
    o_ends := v_last.ends_at + pg_catalog.make_interval(days => p_days);
    o_quota := v_last.ai_quota + p_ai_quota;
  else
    o_starts := greatest(pg_catalog.now(), coalesce(v_last.ends_at, pg_catalog.now()));
    o_ends := o_starts + pg_catalog.make_interval(days => p_days);
    o_quota := p_ai_quota;
  end if;
  if o_quota > 1000 or o_ends > pg_catalog.now() + interval '3650 days' then
    o_err := 'GIFT_TOO_LARGE';
  end if;
end
$$;

create function public.owner_gift(p_session text, p_request_id uuid, p_kn_id text, p_days integer, p_ai_quota integer,
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
  v_p   record;
  v_b   jsonb;
  v_r   jsonb;
  v_id  uuid;
  v_kn  text;
begin
  if not private.panel_post_only() then
    return jsonb_build_object('error', 'METHOD_NOT_ALLOWED');
  end if;
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  v_r := private.panel_request(p_request_id, v_c.o_uid, 'gift',
           jsonb_build_object('kn', p_kn_id, 'days', p_days, 'ai_quota', p_ai_quota, 'note', p_note));
  if v_r is not null then
    return v_r;
  end if;
  begin
    if p_note is not null and pg_catalog.length(p_note) > 200 then
      raise exception 'Комментарий: не больше 200 символов' using errcode = '22023';
    end if;
    select * into v_t from private.panel_target(p_kn_id);
    v_uid := v_t.o_uid;
    v_kn := v_t.o_kn;
    -- порядок блокировок как у выдачи: пользователь (advisory) → строка ai_limits
    perform private.admin_lock(v_uid);
    select * into v_p from private.panel_gift_plan(v_uid, p_days, p_ai_quota);
    if v_p.o_err is not null then
      v_r := jsonb_build_object('error', v_p.o_err);
    else
      perform 1 from private.ai_limits for update;
      v_b := private.panel_gift_budget_check(p_ai_quota);
      if not (v_b ->> 'ok')::boolean then
        v_r := jsonb_build_object('error', 'BUDGET_LOW', 'need', v_b -> 'need', 'free', v_b -> 'free');
      elsif v_p.o_merge is not null then
        update private.access_grants g set ends_at = v_p.o_ends, ai_quota = v_p.o_quota
         where g.id = v_p.o_merge returning g.id into v_id;
      else
        insert into private.access_grants (user_id, kind, plan, starts_at, ends_at, ai_quota, granted_by, note)
        values (v_uid, 'paid', 'gift', v_p.o_starts, v_p.o_ends, v_p.o_quota, 'panel:' || v_c.o_kn,
                nullif(pg_catalog.btrim(p_note), ''))
        returning id into v_id;
      end if;
      if v_id is not null then
        insert into private.access_log (action, user_id, grant_id, actor, details)
        values ('gift', v_uid, v_id, 'panel:' || v_c.o_kn,
                jsonb_build_object('days', p_days, 'ai_quota', p_ai_quota, 'merged', v_p.o_merge is not null,
                                   'starts_at', v_p.o_starts, 'ends_at', v_p.o_ends, 'total_quota', v_p.o_quota,
                                   'note', nullif(pg_catalog.btrim(p_note), '')));
        v_r := jsonb_build_object('result', 'gifted', 'kn_id', v_kn, 'merged', v_p.o_merge is not null,
                 'days', p_days, 'ai_quota', p_ai_quota,
                 'grant', (select jsonb_build_object('starts_at', g.starts_at, 'ends_at', g.ends_at, 'ai_quota', g.ai_quota,
                                                     'ai_used', u.used, 'plan', g.plan)
                             from private.access_grants g cross join lateral private.grant_usage(g.id) u where g.id = v_id),
                 'access', private.access_state(v_uid));
      end if;
    end if;
  exception
    when numeric_value_out_of_range or datetime_field_overflow then
      v_r := jsonb_build_object('error', 'GIFT_TOO_LARGE');
    when others then
      v_r := private.panel_error(sqlstate, sqlerrm);
  end;
  if v_r ? 'error' then
    perform private.panel_refused(v_uid, 'gift', v_r);
  end if;
  return private.panel_request_done(p_request_id, v_r);
end
$$;

-- Статистика панели: подарок — не подписка («с подпиской», «истекают за 7 дней» — только оплаченные сроки)
create or replace function private.panel_student_matches(p_access jsonb, p_filter text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case coalesce(p_filter, 'all')
           when 'all' then true
           when 'paid' then p_access ->> 'status' = 'paid' and p_access ->> 'kind' = 'paid'
                            and p_access ->> 'plan' is distinct from 'gift'
           when 'expiring' then p_access ->> 'status' = 'paid' and p_access ->> 'kind' = 'paid'
                                and p_access ->> 'plan' is distinct from 'gift'
                                and (p_access ->> 'paid_until')::timestamptz <= pg_catalog.now() + interval '7 days'
           when 'trial' then p_access ->> 'status' = 'trial'
           when 'expired' then p_access ->> 'status' = 'expired'
           when 'owner' then p_access ->> 'status' = 'owner'
           when 'legacy' then p_access ->> 'kind' = 'legacy'
           else false end
$$;

-- -------------------------------------------------------------------------------------
-- 6. Права
-- -------------------------------------------------------------------------------------

revoke all on function
  private.premium_obligations(), private.owner_reserve_left(), private.budget_state(), private.panel_ai_state(),
  private.panel_ai_state_base(), private.panel_terms(integer, integer), private.panel_budget_check(integer),
  private.panel_error(text, text), private.panel_gift_plan(uuid, integer, integer), private.panel_student_matches(jsonb, text),
  private.gift_obligations(), private.panel_gift_budget_check(integer)
  from public, anon, authenticated, service_role;

revoke all on function
  public.get_library_paragraph(text, text, text), public.start_text_generation_v2(uuid, uuid, integer, integer, integer),
  public.owner_preview(text, text, text, integer, integer),
  public.owner_grant(text, uuid, text, integer, integer, text, boolean),
  public.owner_extend(text, uuid, text, integer, integer, text, timestamptz, boolean),
  public.owner_set_budget(text, uuid, integer, integer),
  public.owner_gift(text, uuid, text, integer, integer, text)
  from public, anon, authenticated, service_role;

grant execute on function public.get_library_paragraph(text, text, text) to authenticated;
grant execute on function public.start_text_generation_v2(uuid, uuid, integer, integer, integer) to service_role;
grant execute on function
  public.owner_preview(text, text, text, integer, integer),
  public.owner_grant(text, uuid, text, integer, integer, text, boolean),
  public.owner_extend(text, uuid, text, integer, integer, text, timestamptz, boolean),
  public.owner_set_budget(text, uuid, integer, integer),
  public.owner_gift(text, uuid, text, integer, integer, text)
  to authenticated;

-- Таблицы public: Supabase по умолчанию даёт ролям API на новые таблицы TRUNCATE, REFERENCES, TRIGGER и (PostgreSQL 17)
-- MAINTAIN. Через API (PostgREST) их не использовать, но TRUNCATE обходит RLS — убираем: приложению они не нужны.
-- Чтение, запись по колонкам и политики RLS не меняются.
do $$
declare
  v_t    record;
  v_priv text := 'truncate, references, trigger'
                 || case when pg_catalog.current_setting('server_version_num')::integer >= 170000 then ', maintain' else '' end;
begin
  for v_t in select c.oid::regclass as rel from pg_catalog.pg_class c
              where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm') loop
    execute pg_catalog.format('revoke %s on table %s from anon, authenticated, service_role', v_priv, v_t.rel);
  end loop;
end $$;

-- -------------------------------------------------------------------------------------
-- 7. Самопроверка (ошибка — откат всей миграции)
-- -------------------------------------------------------------------------------------

do $$
begin
  if has_table_privilege('anon', 'private.library_paragraphs', 'select')
     or has_table_privilege('authenticated', 'private.library_paragraphs', 'select')
     or has_table_privilege('service_role', 'private.library_paragraphs', 'select') then
    raise exception 'private.library_paragraphs доступна ролям API';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.library_paragraphs'::regclass) then
    raise exception 'RLS на private.library_paragraphs выключен';
  end if;
  if has_function_privilege('anon', 'public.get_library_paragraph(text, text, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.get_library_paragraph(text, text, text)', 'execute') then
    raise exception 'права на get_library_paragraph неверны';
  end if;
  if not has_function_privilege('service_role', 'public.start_text_generation_v2(uuid, uuid, integer, integer, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.start_text_generation_v2(uuid, uuid, integer, integer, integer)', 'execute')
     or has_function_privilege('service_role', 'private.start_text_generation_v2_base(uuid, uuid, integer, integer, integer)', 'execute') then
    raise exception 'права на start_text_generation_v2 неверны';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('owner_grant', 'owner_extend', 'start_text_generation_v2')
              group by p.proname having count(*) > 1) then
    raise exception 'остались старые варианты функций панели';
  end if;
  if exists (select 1 from pg_catalog.pg_class c, unnest(array['anon', 'authenticated', 'service_role']) r
              where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                and (has_table_privilege(r, c.oid, 'truncate') or has_table_privilege(r, c.oid, 'trigger'))) then
    raise exception 'у ролей API осталось TRUNCATE/TRIGGER на таблицах public';
  end if;
  -- PostgreSQL 17 (production): право MAINTAIN тоже снято
  if pg_catalog.current_setting('server_version_num')::integer >= 170000
     and exists (select 1 from pg_catalog.pg_class c, unnest(array['anon', 'authenticated', 'service_role']) r
                  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and has_table_privilege(r, c.oid, 'maintain')) then
    raise exception 'у ролей API осталось MAINTAIN на таблицах public';
  end if;
end $$;

commit;

-- =====================================================================================
-- Откат (вручную, одной транзакцией): supabase/release/rollback-v62.sql — возвращает функции v61.3; тексты библиотеки
-- в private.library_paragraphs удаляются вместе с таблицей (исходник — у владельца вне репозитория). Выдачи с тарифом
-- premium остаются (тариф выключается, а не удаляется). Бюджет ИИ (max_total_starts) не меняется.
-- Перед откатом вернуть клиента v61.3 (без загрузки параграфов с сервера).
-- =====================================================================================
