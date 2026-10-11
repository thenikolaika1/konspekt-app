-- =====================================================================================
-- Konspekt: шесть отчётов аналитики для Supabase SQL Editor (только владелец).
-- Представления лежат в закрытой схеме analytics: у anon/authenticated/service_role нет прав —
-- через API и из приложения они недоступны. Время — Europe/Moscow.
-- Применять после 20261011130000_analytics и 20261011130100_analytics_catalog.
--
-- Неизвестная стоимость AI показывается как NULL и статус UNKNOWN, а не 0 ₽:
-- в ai_generations.estimated_cost = 0 записывается, когда цена не задана (PRICE_PER_M = 0 в analyze-pages).
-- =====================================================================================

-- Показатели за период дней по Москве [p_from; p_to] — общая основа сводки.
create function analytics.period_stats(p_from date, p_to date)
returns table (
  new_ids bigint, active_ids bigint, returning_ids bigint, app_opens bigint, library_opens bigint,
  paragraph_opens bigint, readers bigint, active_seconds bigint, avg_view_seconds bigint,
  ai_success bigint, ai_failed bigint, ai_tokens bigint, ai_cost_known numeric, ai_cost_unknown_rows bigint
)
language sql
stable
set search_path = ''
as $$
  with
  v as (select * from analytics.paragraph_views
         where (opened_at at time zone 'Europe/Moscow')::date between p_from and p_to),
  g as (select * from public.ai_generations
         where (created_at at time zone 'Europe/Moscow')::date between p_from and p_to)
  select
    (select count(*) from auth.users u where (u.created_at at time zone 'Europe/Moscow')::date between p_from and p_to),
    (select count(distinct d.user_id) from analytics.user_days d where d.msk_day between p_from and p_to),
    -- вернувшиеся: активны в периоде в день позже своего первого активного дня
    (select count(distinct d.user_id) from analytics.user_days d
      where d.msk_day between p_from and p_to
        and d.msk_day > (select min(f.msk_day) from analytics.user_days f where f.user_id = d.user_id)),
    (select count(*) from analytics.app_events e where e.kind in ('app_cold', 'app_resume')
        and (e.created_at at time zone 'Europe/Moscow')::date between p_from and p_to),
    (select count(*) from analytics.app_events e where e.kind = 'library_open'
        and (e.created_at at time zone 'Europe/Moscow')::date between p_from and p_to),
    (select count(*) from v),
    (select count(distinct r.user_id) from (
        select user_id from v
        union all
        select user_id from analytics.view_day_seconds s where s.seconds > 0 and s.msk_day between p_from and p_to) r),
    (select coalesce(sum(s.seconds), 0) from analytics.view_day_seconds s where s.msk_day between p_from and p_to),
    (select round(avg(active_seconds))::bigint from v),
    (select count(*) from g where status = 'success'),
    (select count(*) from g where status = 'failed'),
    (select coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0) from g),
    (select sum(estimated_cost) from g where estimated_cost > 0),
    (select count(*) from g where estimated_cost is null or estimated_cost <= 0)
$$;


-- 1. ПОЛЬЗОВАТЕЛИ: одна строка = один анонимный ID (не человек). Сортировка — последняя активность.
create view analytics.r1_users as
with
today as (select (now() at time zone 'Europe/Moscow')::date as d),
isl as (select user_id, msk_day, msk_day - (row_number() over (partition by user_id order by msk_day))::integer as g
          from analytics.user_days),
streaks as (select user_id, count(*)::integer as len, max(msk_day) as last_day from isl group by user_id, g),
st as (select s.user_id, max(s.len) as max_streak,
              max(s.len) filter (where s.last_day >= t.d - 1) as current_streak
         from streaks s cross join today t group by s.user_id),
ad as (select user_id, count(*)::integer as days from analytics.user_days group by user_id),
op as (select user_id,
              count(*) filter (where kind in ('app_cold', 'app_resume'))::integer as opens,
              max(created_at) filter (where kind in ('app_cold', 'app_resume')) as last_open,
              max(created_at) as last_event
         from analytics.app_events group by user_id),
vw as (select user_id, count(*)::integer as views, count(distinct paragraph_id)::integer as uniq,
              sum(active_seconds)::bigint as secs, max(last_seen_at) as last_seen
         from analytics.paragraph_views group by user_id),
ai as (select user_id, count(*) filter (where status = 'success')::integer as ok,
              count(*) filter (where status = 'failed')::integer as failed,
              sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0))::bigint as tokens,
              sum(estimated_cost) filter (where estimated_cost > 0) as cost_known,
              count(*) filter (where estimated_cost is null or estimated_cost <= 0)::integer as cost_unknown,
              max(created_at) as last_ai
         from public.ai_generations group by user_id),
q as (select e.user_id,
             case when private.entitlement_active(e.source) then greatest(e.quota - c.used, 0) else 0 end as remaining
        from private.user_entitlements e
        cross join lateral private.usage_counts(e.user_id, e.resource) c
       where e.resource = 'text_generation')
select
  u.id                                                   as user_id,
  analytics.fmt_msk(u.created_at)                        as registered_msk,
  analytics.fmt_msk(op.last_open)                        as last_app_open_msk,
  coalesce(op.opens, 0)                                  as app_opens,
  coalesce(ad.days, 0)                                   as active_days,
  coalesce(st.current_streak, 0)                         as current_streak_days,
  coalesce(st.max_streak, 0)                             as max_streak_days,
  coalesce(vw.views, 0)                                  as paragraph_opens,
  coalesce(vw.uniq, 0)                                   as unique_paragraphs,
  coalesce(vw.secs, 0)                                   as active_seconds_total,
  analytics.fmt_duration(coalesce(vw.secs, 0))           as active_total_hms,
  round(vw.secs::numeric / nullif(vw.views, 0))::integer as avg_active_seconds,
  analytics.fmt_duration(round(vw.secs::numeric / nullif(vw.views, 0))::bigint) as avg_active_ms,
  coalesce(ai.ok, 0)                                     as ai_success,
  coalesce(ai.failed, 0)                                 as ai_failed,
  q.remaining                                            as ai_free_remaining,   -- NULL: права на генерацию нет
  ai.tokens                                              as ai_tokens,
  case when ai.cost_unknown > 0 then null else ai.cost_known end as ai_cost_rub,
  case when ai.user_id is null then null when ai.cost_unknown > 0 then 'UNKNOWN' else 'ESTIMATED' end as ai_cost_status,
  analytics.fmt_msk(greatest(op.last_event, vw.last_seen, ai.last_ai, u.created_at)) as last_activity_msk
from auth.users u
left join op on op.user_id = u.id
left join ad on ad.user_id = u.id
left join st on st.user_id = u.id
left join vw on vw.user_id = u.id
left join ai on ai.user_id = u.id
left join q  on q.user_id = u.id
order by greatest(op.last_event, vw.last_seen, ai.last_ai, u.created_at) desc;


-- 2. ПОСЕЩЕНИЯ: одна строка = одна сессия просмотра параграфа. Сортировка — новые сверху.
create view analytics.r2_views as
select
  v.user_id,
  c.subject_title                                                          as subject,
  c.book_title                                                             as book,
  c.book_authors                                                           as authors,
  coalesce(c.number, 'Итоги')                                              as paragraph_number,
  c.title                                                                  as paragraph_title,
  to_char(v.opened_at at time zone 'Europe/Moscow', 'YYYY-MM-DD')          as visit_date_msk,
  to_char(v.opened_at at time zone 'Europe/Moscow', 'HH24:MI:SS')          as opened_time_msk,
  to_char(v.ended_at at time zone 'Europe/Moscow', 'HH24:MI:SS')           as ended_time_msk,     -- NULL: не известно
  to_char(v.last_seen_at at time zone 'Europe/Moscow', 'HH24:MI:SS')       as last_seen_time_msk,
  case when v.ended_at is not null then 'завершена'
       when v.last_seen_at < now() - interval '30 minutes' then 'прервана'
       else 'идёт' end                                                     as status,
  v.active_seconds,
  analytics.fmt_duration(v.active_seconds)                                 as active_ms,
  (select count(*) from analytics.view_day_seconds d where d.view_id = v.id) > 1 as crosses_midnight,
  (select (v.opened_at at time zone 'Europe/Moscow')::date between f.first_day and f.last_day from analytics.ff_period f) as in_ff,
  v.id                                                                     as view_session_id
from analytics.paragraph_views v
join analytics.catalog_paragraphs c on c.id = v.paragraph_id
order by v.opened_at desc;


-- 3. ПОПУЛЯРНЫЕ ПАРАГРАФЫ: одна строка = один материал каталога (в том числе без просмотров).
create view analytics.r3_paragraphs as
select
  c.subject_title                                               as subject,
  c.book_title                                                  as book,
  coalesce(c.number, 'Итоги')                                   as paragraph_number,
  c.title                                                       as paragraph_title,
  count(v.id)                                                   as opens,
  count(distinct v.user_id)                                     as unique_users,
  coalesce(sum(v.active_seconds), 0)                            as active_seconds_total,
  analytics.fmt_duration(coalesce(sum(v.active_seconds), 0))    as active_total_hms,
  round(avg(v.active_seconds))::integer                         as avg_active_seconds,
  analytics.fmt_duration(round(avg(v.active_seconds))::bigint)  as avg_active_ms,
  analytics.fmt_msk(max(v.opened_at))                           as last_opened_msk,
  c.retired,
  c.id                                                          as paragraph_id
from analytics.catalog_paragraphs c
left join analytics.paragraph_views v on v.paragraph_id = c.id
group by c.id
order by count(v.id) desc, coalesce(sum(v.active_seconds), 0) desc, c.book_id, c.sort_order;


-- 4. ПО ДНЯМ: одна строка = один день по Москве (00:00:00–23:59:59), новые дни сверху.
-- Активное время — по дню получения (сессия через полночь делится между днями); открытие — по дню открытия.
create view analytics.r4_daily as
with
bounds as (select least(coalesce((select min((u.created_at at time zone 'Europe/Moscow')::date) from auth.users u), f.first_day),
                        coalesce((select min(x.msk_day) from analytics.user_days x), f.first_day),
                        f.first_day) as d0,
                  (now() at time zone 'Europe/Moscow')::date as d1, f.first_day, f.last_day
             from analytics.ff_period f),
days as (select generate_series(b.d0, b.d1, interval '1 day')::date as d, b.first_day, b.last_day from bounds b)
select
  days.d                                                   as msk_date,
  s.new_ids, s.active_ids,
  (select count(distinct a.user_id) from analytics.user_days a
    where a.msk_day = days.d
      and exists (select 1 from analytics.user_days y where y.user_id = a.user_id and y.msk_day = days.d - 1)) as returned_from_yesterday,
  s.app_opens, s.library_opens, s.paragraph_opens,
  s.readers                                                as unique_readers,
  s.active_seconds,
  analytics.fmt_duration(s.active_seconds)                 as active_hms,
  s.ai_success, s.ai_failed,
  case when s.ai_cost_unknown_rows > 0 then null else s.ai_cost_known end as ai_cost_rub,
  case when s.ai_success + s.ai_failed = 0 then null when s.ai_cost_unknown_rows > 0 then 'UNKNOWN' else 'ESTIMATED' end as ai_cost_status,
  days.d between days.first_day and days.last_day          as in_ff
from days
cross join lateral analytics.period_stats(days.d, days.d) s
order by days.d desc;


-- 5. AI-ГЕНЕРАЦИИ: одна строка = один запуск генерации, в котором вызывался AI (как пишет analyze-pages).
-- Не записываются: отказы до вызова AI (нет права, лимит, 5+ страниц), отдельные вызовы провайдеров,
-- коды ошибок — они только в логах Edge Function. Повторы и fallback внутри запуска — одна строка,
-- токены — сумма ответов, поэтому расход не задваивается.
create view analytics.r5_ai as
select
  g.user_id,
  analytics.fmt_msk(g.created_at)                                    as time_msk,
  g.page_count                                                       as pages,
  analytics.ai_provider(g.model)                                     as provider,
  g.model,
  g.status,
  round(g.latency / 1000.0, 1)                                       as duration_s,
  null::text                                                         as error_code,       -- не записывается в ai_generations
  g.status = 'success'                                               as quota_charged,    -- успех = note ready = consumed
  g.input_tokens,
  g.output_tokens,
  case when g.estimated_cost > 0 then g.estimated_cost end           as cost_rub,
  case when g.estimated_cost > 0 then 'ESTIMATED' else 'UNKNOWN' end as cost_status,
  (select (g.created_at at time zone 'Europe/Moscow')::date between f.first_day and f.last_day from analytics.ff_period f) as in_ff,
  g.id                                                               as generation_id
from public.ai_generations g
order by g.created_at desc;


-- 6. СВОДКА: одна строка = один показатель; периоды в отдельных столбцах (не смешиваются).
create view analytics.r6_summary as
with
t as (select (now() at time zone 'Europe/Moscow')::date as d),
a as (select s.* from t, analytics.period_stats(date '2000-01-01', t.d) s),
f as (select s.* from analytics.ff_period p, analytics.period_stats(p.first_day, p.last_day) s),
d as (select s.* from t, analytics.period_stats(t.d, t.d) s),
w as (select s.* from t, analytics.period_stats(t.d - 6, t.d) s),
l as (select * from private.ai_limits),
b as (select coalesce(sum(blocked_attempts), 0) as blocked from private.user_entitlements),
cost as (select x.k, case when x.unknown > 0 then 'UNKNOWN' when x.known is null then '—' else round(x.known, 2)::text end as v
           from (values ('a', (select ai_cost_known from a), (select ai_cost_unknown_rows from a)),
                        ('f', (select ai_cost_known from f), (select ai_cost_unknown_rows from f)),
                        ('d', (select ai_cost_known from d), (select ai_cost_unknown_rows from d)),
                        ('w', (select ai_cost_known from w), (select ai_cost_unknown_rows from w))) x(k, known, unknown))
select v.n, v.metric, v.all_time, v.ff, v.today, v.last_7_days
from a, f, d, w, l, b,
lateral (values
  (1,  'Анонимные ID (новые за период; за всё время — всего)', a.new_ids::text, f.new_ids::text, d.new_ids::text, w.new_ids::text),
  (2,  'Активные ID', a.active_ids::text, f.active_ids::text, d.active_ids::text, w.active_ids::text),
  (3,  'Вернувшиеся ID (активны позже своего первого дня)', a.returning_ids::text, f.returning_ids::text, d.returning_ids::text, w.returning_ids::text),
  (4,  'Открытия приложения', a.app_opens::text, f.app_opens::text, d.app_opens::text, w.app_opens::text),
  (5,  'Открытия библиотеки', a.library_opens::text, f.library_opens::text, d.library_opens::text, w.library_opens::text),
  (6,  'Открытия параграфов', a.paragraph_opens::text, f.paragraph_opens::text, d.paragraph_opens::text, w.paragraph_opens::text),
  (7,  'Уникальные читатели', a.readers::text, f.readers::text, d.readers::text, w.readers::text),
  (8,  'Приблизительное активное время просмотра (Ч:ММ:СС)', analytics.fmt_duration(a.active_seconds), analytics.fmt_duration(f.active_seconds),
        analytics.fmt_duration(d.active_seconds), analytics.fmt_duration(w.active_seconds)),
  (9,  'Среднее активное время на просмотр (М:СС)', analytics.fmt_duration(a.avg_view_seconds), analytics.fmt_duration(f.avg_view_seconds),
        analytics.fmt_duration(d.avg_view_seconds), analytics.fmt_duration(w.avg_view_seconds)),
  (10, 'Успешные AI-генерации', a.ai_success::text, f.ai_success::text, d.ai_success::text, w.ai_success::text),
  (11, 'Ошибки AI (AI вызывался, конспект не сохранён)', a.ai_failed::text, f.ai_failed::text, d.ai_failed::text, w.ai_failed::text),
  (12, 'Расход AI, ₽ (UNKNOWN — цена не задана)', (select v from cost where k = 'a'), (select v from cost where k = 'f'),
        (select v from cost where k = 'd'), (select v from cost where k = 'w')),
  (13, 'AI-токены (вход + выход)', a.ai_tokens::text, f.ai_tokens::text, d.ai_tokens::text, w.ai_tokens::text),
  (14, 'AI-запуски по счётчику №10.2 (total_starts / max_total_starts)', l.total_starts || ' / ' || l.max_total_starts, '—', '—', '—'),
  (15, 'Осталось AI-запусков', case when not l.ai_enabled then 'AI выключен (ai_enabled = false)'
                                     else greatest(l.max_total_starts - l.total_starts, 0)::text end, '—', '—', '—'),
  (16, 'Отказы по лимиту пользователя (blocked_attempts, всего)', b.blocked::text, '—', '—', '—')
) v(n, metric, all_time, ff, today, last_7_days)
order by v.n;


revoke all on all tables in schema analytics from public, anon, authenticated, service_role;
revoke all on all functions in schema analytics from public, anon, authenticated, service_role;
