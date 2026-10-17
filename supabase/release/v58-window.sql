-- Konspekt v58: окно F&F 19–23 октября 2026 включительно (МСК). Применять ТОЛЬКО по решению владельца.
-- Начало 19.10.2026 00:00 МСК (= 18.10 21:00 UTC), конец 24.10.2026 00:00 МСК (= 23.10 21:00 UTC), граница не входит:
-- private.entitlement_active: now() >= beta_starts_at and now() < beta_ends_at.
-- AI НЕ включается: max_total_starts, ai_enabled и остальные лимиты не меняются (AI по-прежнему 0 запусков).
begin;
update private.ai_limits
   set beta_starts_at = '2026-10-19 00:00:00+03',
       beta_ends_at   = '2026-10-24 00:00:00+03',
       updated_at     = now()
 where id;
do $$
begin
  if (select count(*) from private.ai_limits
       where beta_starts_at = '2026-10-18 21:00:00+00' and beta_ends_at = '2026-10-23 21:00:00+00') <> 1 then
    raise exception 'окно не установлено';
  end if;
end $$;
select beta_starts_at at time zone 'Europe/Moscow' as start_msk, beta_ends_at at time zone 'Europe/Moscow' as end_msk_exclusive,
       max_total_starts, total_starts, ai_enabled
  from private.ai_limits;
commit;
