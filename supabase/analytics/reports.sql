-- =====================================================================================
-- Konspekt: шесть отчётов аналитики. Запускать в Supabase Dashboard → SQL Editor (только владелец).
-- Каждый блок — отдельный запрос: выделите его и нажмите Run (Ctrl/Cmd + Enter).
-- Время — по Москве. User ID — анонимный идентификатор, не человек.
-- «Активное время» — приблизительное активное время просмотра, а не доказательство чтения.
-- Реальные результаты не сохранять в репозиторий.
-- =====================================================================================

-- 1. Пользователи (последняя активность сверху)
select * from analytics.r1_users;

-- 2. Посещения конспектов (новые сверху). Только F&F:
select * from analytics.r2_views where in_ff;

-- 3. Популярные параграфы (по числу открытий)
select * from analytics.r3_paragraphs;

-- 4. Статистика по дням (новые дни сверху). Только F&F:
select * from analytics.r4_daily where in_ff;

-- 5. AI-генерации (новые сверху). Только F&F:
select * from analytics.r5_ai where in_ff;

-- 6. Общая сводка: за всё время / F&F / сегодня / последние 7 дней
select metric, all_time, ff, today, last_7_days from analytics.r6_summary;


-- ----- Дополнительно -----

-- Посещения одного пользователя:
-- select * from analytics.r2_views where user_id = '<user_id>';

-- Посещения за выбранные дни (по Москве):
-- select * from analytics.r2_views where visit_date_msk between '2026-10-12' and '2026-10-18';

-- ТОП предметов и учебников за F&F:
-- select c.subject_title, c.book_title, count(*) as opens, count(distinct v.user_id) as unique_users,
--        analytics.fmt_duration(sum(v.active_seconds)) as active_total
--   from analytics.paragraph_views v join analytics.catalog_paragraphs c on c.id = v.paragraph_id, analytics.ff_period f
--  where (v.opened_at at time zone 'Europe/Moscow')::date between f.first_day and f.last_day
--  group by rollup (c.subject_title, c.book_title) order by opens desc;

-- Лимиты AI (№10.2):
-- select * from private.ai_limits;
