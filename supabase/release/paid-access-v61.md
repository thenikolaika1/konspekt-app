# v61: пробный период и платный доступ — выпуск и ручное управление

Ничего из этого не выполнено в production. Каждый шаг — только после отдельного разрешения владельца.

## Что меняется

| Часть | Файл | Что делает |
|---|---|---|
| База | `supabase/migrations/20261024150000_paid_access.sql` | Таблицы `private.access_grants`, `private.plans` (пустая), `private.access_settings`, `private.access_log`; поле `usage_ledger.grant_id`; функции `get_my_access_v2`, `get_plans`, `start_text_generation_v2`, `admin_*`; пробный период новым регистрациям (триггер) |
| Функция | `supabase/functions/analyze-pages/index.ts` | Проверка перед генерацией — `start_text_generation_v2` (основа — код production v24) |
| Приложение | `app.js`, `js/cloud.js`, `js/config.js`, `styles.css`, `index.html`, `service-worker.js` | Статус доступа с сервера, «Доступ закончился», «Тарифы», «Мой доступ», строка пробного периода; v61 |

Не меняются: существующие строки, права 7 участников F&F, анонимные служебные аккаунты, лимиты `ai_limits` (бюджет 40), приглашения, `get_my_access` и `start_text_generation` (клиенты v59).

## Порядок выпуска

1. **Миграция** (SQL Editor, весь файл). Проверка: `select private.access_state(null);` → `{"status":"none",…}`; `select count(*) from private.access_grants;` → 0.
   v59 продолжает работать: старые функции не тронуты, новые ещё не вызываются.
2. **analyze-pages** — выкладка версии из этой ветки. Пользователи без выдач (все сегодняшние) идут прежней проверкой.
3. **Приложение v61** — merge в `main` (GitHub Pages).
4. **Аккаунт владельца** (по желанию): зарегистрировать ID по служебному коду, затем `select private.admin_set_owner('KN-XXXXXX', 'владелец');`.

Откат: шаг 3 — revert в `main`; шаг 2 — прежняя версия функции (v24); шаг 1 — блок «Откат» в конце миграции.

## Ручное управление (SQL Editor)

```sql
-- что у участника сейчас: статус, все сроки с использованием, журнал
select private.admin_status('KN-XXXXXX');

-- первая оплата: доступ с этого момента; срок и генерации — явно или из тарифа (private.plans)
select private.admin_grant('KN-XXXXXX', null, 30, 20, 'оплата 01.11');
select private.admin_grant('KN-XXXXXX', 'код_тарифа', null, null, 'оплата 01.11');

-- продление: с конца текущего срока (заранее — время не теряется) или с этого момента (после окончания);
-- у нового срока свой лимит, остаток прежнего не переносится
select private.admin_extend('KN-XXXXXX', null, 30, 20, 'продление');

-- отзыв действующего и будущих сроков (строки и журнал остаются)
select private.admin_revoke('KN-XXXXXX', 'причина');

-- будущий перенос (например, участников F&F) — пробный период вручную, один раз на аккаунт
select private.admin_grant_trial('KN-XXXXXX', 'перенос F&F');
```

Тарифы для экрана «Тарифы» (видны только `active = true`; цена — только если задана):

```sql
insert into private.plans (code, title, days, ai_quota, price_label, description, active)
values ('…', '…', 30, 20, null, null, true);
```

Параметры пробного периода: `private.access_settings` (`trial_days` 7, `trial_ai_quota` 1, `trial_on_register`).

## Ограничения

- Экран «Доступ закончился» — интерфейс. Генерацию ИИ закрывает сервер, а тексты библиотеки лежат в публичном `js/library-catalog.js` и экраном не защищены.
- Общий бюджет ИИ (`ai_limits.max_total_starts` = 40) общий для всех, включая владельца; перед продажами его нужно согласовать отдельно.
- Повторная регистрация по новому приглашению даёт новый пробный период — организационный риск (коды выпускает владелец).
