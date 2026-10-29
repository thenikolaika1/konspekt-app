-- v62: скрыть цену Premium от учеников — public.get_plans() больше не отдаёт price_label.
-- ОТДЕЛЬНЫЙ шаг выпуска: после миграции v62 и проверки (шаг 2б инструкции), только по решению владельца.
-- Цена остаётся только в панели владельца (её тексты в js/owner.js); срок и число генераций не меняются.
-- Одна транзакция: при любой неожиданности — ошибка и ничего не изменено. Отмена — v62-hide-price-undo.sql.
-- ВАЖНО: перед повторным применением миграции v62 (например, после отката) сначала выполнить отмену:
--   миграция проверяет, что тариф premium — «30 дней / 10 / 299 ₽», и иначе останавливается (ничего не меняя).
-- Запуск одним запросом (SQL Editor → весь файл → Run) или psql -X -v ON_ERROR_STOP=1 -f.
begin;
set local lock_timeout = '5s';
do $$
declare
  v_n integer;
begin
  if to_regclass('private.library_paragraphs') is null then
    raise exception 'v62 не применена — сначала миграция 20261028120000_v62_paid_library.sql';
  end if;
  if exists (select 1 from private.plans p where p.code = 'premium' and p.price_label is null) then
    raise exception 'цена Premium уже скрыта — ничего не изменено';
  end if;
  update private.plans p set price_label = null, updated_at = pg_catalog.now()
   where p.code = 'premium' and p.active and p.title = 'Premium' and p.days = 30 and p.ai_quota = 10 and p.price_label = '299 ₽';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'тариф premium не в ожидаемом состоянии (Premium, 30 дней, 10 генераций, 299 ₽, активен) — ничего не изменено';
  end if;
  -- проверка результата так, как его видит ученик: ни у одного тарифа в ответе get_plans нет цены
  if exists (select 1 from pg_catalog.jsonb_array_elements(public.get_plans()) e where e ->> 'price_label' is not null) then
    raise exception 'get_plans всё ещё отдаёт цену — изменение отменено';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(public.get_plans()) e
       where e ->> 'code' = 'premium' and (e ->> 'days')::integer = 30 and (e ->> 'ai_quota')::integer = 10) <> 1 then
    raise exception 'после изменения Premium в get_plans не 30 дней / 10 генераций — изменение отменено';
  end if;
  raise notice 'цена Premium скрыта: get_plans отдаёт Premium, 30 дней, 10 генераций, без цены';
end $$;
commit;
-- Проверка после (только чтение): ожидается premium|30|10|NULL|t
-- select code, days, ai_quota, price_label, active from private.plans where code = 'premium';
