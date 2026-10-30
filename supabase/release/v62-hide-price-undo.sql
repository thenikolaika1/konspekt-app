-- Отмена v62-hide-price.sql: вернуть price_label = '299 ₽' у тарифа premium (get_plans снова отдаёт цену).
-- Нужна перед повторным применением миграции v62 после отката (миграция проверяет «30 / 10 / 299 ₽»).
-- Приложение v62 цену всё равно не показывает. Одна транзакция; если тариф не в ожидаемом состоянии — ничего не меняет.
begin;
set local lock_timeout = '5s';
do $$
declare
  v_n integer;
begin
  update private.plans p set price_label = '299 ₽', updated_at = pg_catalog.now()
   where p.code = 'premium' and p.title = 'Premium' and p.days = 30 and p.ai_quota = 10 and p.price_label is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'тариф premium не в ожидаемом состоянии (Premium, 30 дней, 10 генераций, цена скрыта) — ничего не изменено';
  end if;
  raise notice 'цена Premium возвращена (299 ₽)';
end $$;
commit;
-- Проверка после (только чтение): ожидается premium|30|10|299 ₽
-- select code, days, ai_quota, price_label from private.plans where code = 'premium';
