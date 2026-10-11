-- =====================================================================================
-- Konspekt: аналитика P0 (Friends & Family) — открытия приложения и библиотеки, просмотры параграфов,
-- приблизительное активное время просмотра. Отчёты — только владельцу в Supabase SQL Editor.
--
-- Применять ПОСЛЕ 20261011120000_ff_ai_limits (№10.2): отчёты читают private.ai_limits.
-- Справочник параграфов заполняет следующая миграция (20261011130100_analytics_catalog, генерируется
-- tools/catalog-to-sql.mjs из js/library-catalog.js).
--
-- Безопасность:
--   • схема analytics не публикуется через API: у anon/authenticated/service_role нет USAGE;
--   • писать можно только через public.track(p_events) (authenticated): user_id = auth.uid(),
--     чужие id и неизвестные параграфы отбрасываются, время ограничено сервером;
--   • читать события и отчёты из приложения нельзя никому (нет SELECT, нет публичных VIEW).
-- Данные: только анонимный user_id, id параграфа из каталога, время сервера, номер сборки.
-- Без IP, устройства, геолокации, имён, ключей и текстов личных конспектов.
-- Время в отчётах — Europe/Moscow.
--
-- Откат без потери данных: revoke execute on function public.track(jsonb) from authenticated;
-- (и analytics: false в js/config.js). Таблицы и собранные данные остаются.
-- =====================================================================================

do $$
begin
  if to_regclass('private.ai_limits') is null then
    raise exception 'Сначала примените 20261011120000_ff_ai_limits (№10.2)';
  end if;
end
$$;

create schema analytics;
revoke all on schema analytics from public, anon, authenticated, service_role;


-- -------------------------------------------------------------------------------------
-- 1. Таблицы
-- -------------------------------------------------------------------------------------

-- Справочник материалов библиотеки. id — постоянный ключ из js/library-catalog.js: не меняется при правке
-- текста или названия. Материал, убранный из каталога, не удаляется (retired), чтобы старые просмотры остались.
create table analytics.catalog_paragraphs (
  id            text        primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  subject_id    text        not null,
  subject_title text        not null,
  book_id       text        not null,
  book_title    text        not null,
  book_authors  text,
  grade         text,
  number        text,
  title         text        not null,
  chapter       text,
  kind          text,
  sort_order    integer     not null,
  is_summary    boolean     not null default false,
  retired       boolean     not null default false,
  updated_at    timestamptz not null default now()
);

-- События приложения: открытие (холодный старт / возврат после ≥ 30 мин в фоне) и вход в библиотеку.
-- id создаёт клиент (UUID): повторная отправка того же события ничего не добавляет.
create table analytics.app_events (
  id         uuid        primary key,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  kind       text        not null check (kind in ('app_cold', 'app_resume', 'library_open')),
  created_at timestamptz not null default now(),
  app_build  text        check (app_build ~ '^[0-9A-Za-z._-]{1,16}$')
);
create index app_events_user_time on analytics.app_events (user_id, created_at);
create index app_events_time on analytics.app_events (created_at);

-- Сессия просмотра параграфа: непрерывное пребывание на экране параграфа (фон до 30 мин — та же сессия).
-- active_seconds — «приблизительное активное время просмотра»: только видимый экран и не дольше 120 с
-- после последнего касания / прокрутки / клавиши; сервер не даёт ему превысить прошедшее время.
create table analytics.paragraph_views (
  id             uuid        primary key,
  user_id        uuid        not null references auth.users (id) on delete cascade,
  paragraph_id   text        not null references analytics.catalog_paragraphs (id),
  opened_at      timestamptz not null,
  last_seen_at   timestamptz not null,
  ended_at       timestamptz,
  active_seconds integer     not null default 0 check (active_seconds between 0 and 3600),
  flushes        integer     not null default 1 check (flushes >= 1),
  app_build      text        check (app_build ~ '^[0-9A-Za-z._-]{1,16}$'),
  constraint paragraph_views_time_check check (last_seen_at >= opened_at)
);
create index paragraph_views_user_time on analytics.paragraph_views (user_id, opened_at);
create index paragraph_views_paragraph on analytics.paragraph_views (paragraph_id);
create index paragraph_views_time on analytics.paragraph_views (opened_at);

-- Активное время по дням (Москва): прирост записывается в день, когда сервер его получил
-- (клиент присылает накопленное время каждые 60 с), поэтому сессия через полночь делится между днями
-- с точностью до одной отправки.
create table analytics.view_day_seconds (
  view_id uuid    not null references analytics.paragraph_views (id) on delete cascade,
  user_id uuid    not null references auth.users (id) on delete cascade,
  msk_day date    not null,
  seconds integer not null check (seconds >= 0),
  primary key (view_id, msk_day)
);
create index view_day_seconds_user_day on analytics.view_day_seconds (user_id, msk_day);
create index view_day_seconds_day on analytics.view_day_seconds (msk_day);

alter table analytics.catalog_paragraphs enable row level security;
alter table analytics.app_events         enable row level security;
alter table analytics.paragraph_views    enable row level security;
alter table analytics.view_day_seconds   enable row level security;
revoke all on all tables in schema analytics from public, anon, authenticated, service_role;


-- -------------------------------------------------------------------------------------
-- 2. Приём событий
-- -------------------------------------------------------------------------------------
-- Пакет (≤ 20 событий):
--   { "t": "ev",   "id": uuid, "k": "app_cold" | "app_resume" | "library_open", "b": "54" }
--   { "t": "view", "id": uuid, "p": "<id параграфа>", "s": <накопленные активные секунды>,
--     "a": <секунд с открытия сессии по часам клиента>, "end": true|false, "b": "54" }
-- Повтор одного и того же пакета ничего не меняет. Неверное событие пропускается, остальные принимаются.
-- Ограничения на пользователя в сутки (Москва): 200 событий приложения, 300 сессий просмотра,
-- 6 ч активного времени; на сессию — 3600 с; сессия старше 12 ч и завершённая не обновляются.
-- Ответ: { ok, skipped }.

create function analytics.track_at(p_uid uuid, p_events jsonb, p_now timestamptz)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  c_batch      constant integer := 20;
  c_day_events constant integer := 200;
  c_day_views  constant integer := 300;
  c_day_secs   constant integer := 21600;
  c_view_secs  constant integer := 3600;
  c_view_hours constant integer := 12;
  v_day        date := (p_now at time zone 'Europe/Moscow')::date;
  v_day_start  timestamptz := (v_day::timestamp at time zone 'Europe/Moscow');
  v_ok         integer := 0;
  v_skipped    integer := 0;
  e            jsonb;
  v_id         uuid;
  v_build      text;
  v_kind       text;
  v_para       text;
  v_s          integer;
  v_a          integer;
  v_end        boolean;
  v_view       record;
  v_target     integer;
  v_delta      integer;
  v_used       integer;
  v_new        boolean;
begin
  if p_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > c_batch then
    raise exception 'BAD_BATCH' using errcode = '22023';
  end if;
  -- пакеты одного пользователя — по очереди (дневные лимиты считаются без гонок)
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('analytics:' || p_uid::text, 0));

  for e in select value from pg_catalog.jsonb_array_elements(p_events) loop
    begin
      if jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'id') <> 'string' then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      v_id := (e ->> 'id')::uuid;
      v_build := case when (e ->> 'b') ~ '^[0-9A-Za-z._-]{1,16}$' then e ->> 'b' end;

      if e ->> 't' = 'ev' then
        v_kind := e ->> 'k';
        if v_kind is null or v_kind not in ('app_cold', 'app_resume', 'library_open')
           or (select count(*) from analytics.app_events x
                where x.user_id = p_uid and x.created_at >= v_day_start) >= c_day_events then
          v_skipped := v_skipped + 1;
          continue;
        end if;
        insert into analytics.app_events (id, user_id, kind, created_at, app_build)
        values (v_id, p_uid, v_kind, p_now, v_build)
        on conflict (id) do nothing;
        v_ok := v_ok + 1;

      elsif e ->> 't' = 'view' then
        v_para := e ->> 'p';
        v_s := greatest(coalesce(pg_catalog.round((e ->> 's')::numeric)::integer, 0), 0);
        v_a := least(greatest(coalesce(pg_catalog.round((e ->> 'a')::numeric)::integer, 0), 0), c_view_hours * 3600);
        v_end := coalesce((e ->> 'end')::boolean, false);

        select * into v_view from analytics.paragraph_views where id = v_id for update;
        v_new := not found;
        if v_new then
          if not exists (select 1 from analytics.catalog_paragraphs c where c.id = v_para)
             or (select count(*) from analytics.paragraph_views x
                  where x.user_id = p_uid and x.opened_at >= v_day_start) >= c_day_views then
            v_skipped := v_skipped + 1;
            continue;
          end if;
          -- начало сессии — по часам клиента, но не раньше 12 ч назад; время ≤ прошедшего с открытия
          insert into analytics.paragraph_views (id, user_id, paragraph_id, opened_at, last_seen_at, active_seconds, app_build)
          values (v_id, p_uid, v_para, p_now - pg_catalog.make_interval(secs => v_a), p_now, 0, v_build)
          returning * into v_view;
          v_target := least(v_s, v_a + 10, c_view_secs);
        else
          if v_view.user_id <> p_uid or v_view.paragraph_id is distinct from v_para
             or v_view.ended_at is not null or p_now > v_view.opened_at + pg_catalog.make_interval(hours => c_view_hours) then
            v_skipped := v_skipped + 1;
            continue;
          end if;
          -- накопленное время не убывает и не больше времени с открытия сессии (+10 с на неточность часов;
          -- допуск один на сессию, а не на запрос — частые запросы время не завышают)
          v_target := least(greatest(v_s, v_view.active_seconds),
                            floor(extract(epoch from p_now - v_view.opened_at))::integer + 10,
                            c_view_secs);
        end if;

        select coalesce(sum(d.seconds), 0)::integer into v_used
          from analytics.view_day_seconds d where d.user_id = p_uid and d.msk_day = v_day;
        v_delta := least(greatest(v_target - v_view.active_seconds, 0), greatest(c_day_secs - v_used, 0));

        update analytics.paragraph_views
           set active_seconds = active_seconds + v_delta,
               last_seen_at   = greatest(last_seen_at, p_now),
               flushes        = flushes + case when v_new then 0 else 1 end,
               ended_at       = case when v_end then p_now else ended_at end
         where id = v_id;
        if v_delta > 0 then
          insert into analytics.view_day_seconds as d (view_id, user_id, msk_day, seconds)
          values (v_id, p_uid, v_day, v_delta)
          on conflict (view_id, msk_day) do update set seconds = d.seconds + excluded.seconds;
        end if;
        v_ok := v_ok + 1;

      else
        v_skipped := v_skipped + 1;
      end if;
    exception
      when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value
           or datetime_field_overflow then
        v_skipped := v_skipped + 1;
    end;
  end loop;

  return jsonb_build_object('ok', v_ok, 'skipped', v_skipped);
end
$$;

-- Единственная точка записи для клиента: пользователь — только из JWT (auth.uid()), время — сервера.
create function public.track(p_events jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return analytics.track_at(auth.uid(), p_events, pg_catalog.now());
end
$$;

revoke all on function analytics.track_at(uuid, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.track(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.track(jsonb) to authenticated;


-- -------------------------------------------------------------------------------------
-- 3. Вспомогательное для отчётов
-- -------------------------------------------------------------------------------------

-- Секунды → «М:СС» или «Ч:ММ:СС»
create function analytics.fmt_duration(p_seconds bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_seconds is null then null
    when p_seconds >= 3600 then (p_seconds / 3600)::text || ':' || pg_catalog.lpad(((p_seconds % 3600) / 60)::text, 2, '0')
                                 || ':' || pg_catalog.lpad((p_seconds % 60)::text, 2, '0')
    else (p_seconds / 60)::text || ':' || pg_catalog.lpad((p_seconds % 60)::text, 2, '0')
  end
$$;

-- Время → строка по Москве
create function analytics.fmt_msk(p_ts timestamptz)
returns text
language sql
stable
set search_path = ''
as $$ select pg_catalog.to_char(p_ts at time zone 'Europe/Moscow', 'YYYY-MM-DD HH24:MI:SS') $$;

-- Период F&F по Москве (дни включительно) — из private.ai_limits (№10.2), единственный источник дат.
create view analytics.ff_period as
  select (l.beta_starts_at at time zone 'Europe/Moscow')::date                                         as first_day,
         ((l.beta_ends_at at time zone 'Europe/Moscow') - interval '1 microsecond')::date             as last_day,
         l.beta_starts_at, l.beta_ends_at
    from private.ai_limits l;

-- Провайдер AI по полю model в ai_generations: у успешных — модель, у полного провала — список провайдеров.
create function analytics.ai_provider(p_model text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_model ~ '^(gigachat|openrouter|zai)(/(gigachat|openrouter|zai))*$' then 'не определён (отказали все: ' || p_model || ')'
    when p_model ilike 'gigachat%' then 'gigachat'
    when p_model ilike 'glm%' then 'zai'
    when p_model like '%/%' then 'openrouter'
    else 'не определён'
  end
$$;

-- Дни активности анонимного ID (Москва): открытие приложения или библиотеки, просмотр, AI-запрос.
create view analytics.user_days as
  select user_id, (created_at at time zone 'Europe/Moscow')::date as msk_day from analytics.app_events
  union
  select user_id, (opened_at at time zone 'Europe/Moscow')::date from analytics.paragraph_views
  union
  select user_id, msk_day from analytics.view_day_seconds where seconds > 0
  union
  select user_id, (created_at at time zone 'Europe/Moscow')::date from public.ai_generations;

revoke all on all tables in schema analytics from public, anon, authenticated, service_role;
revoke all on all functions in schema analytics from public, anon, authenticated, service_role;
