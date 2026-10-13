-- ОТКЛЮЧЕНИЕ АНАЛИТИКИ №10.3 без потери данных: клиенты больше не могут отправлять события.
-- Таблицы analytics.* и собранные данные остаются; отчёты r1–r6 продолжают работать в SQL Editor.
-- Включить обратно: grant execute on function public.track(jsonb) to authenticated;
revoke execute on function public.track(jsonb) from authenticated;
