# Выпуск v58: регистрация по приглашениям — точный порядок

Каждый шаг выполняет владелец (или по его явному разрешению). AI в этом выпуске **не включается**
(`private.ai_limits.max_total_starts` остаётся 0). Команды — PowerShell на компьютере владельца, в папке репозитория
на ветке `ff-invite-register`.

Порядок важен: **база → функция → проверка → сайт → коды → окно**. Сайт v58 без функции не сможет регистрировать;
функция без миграции отвечает «Сервер временно недоступен».

## 0. Подготовка (ничего не меняет)

1. Ветка и коммит: `git fetch; git checkout ff-invite-register; git log -1` — ожидаемый коммит указан в отчёте выпуска.
2. Резервная копия production (как в прошлый раз, `pg_dump`), файл проверен — открывается и не пустой.
3. Переменные подключения к базе (Session pooler из Dashboard → Connect), пароль вводится только у вас:
   `$env:PGHOST='…'; $env:PGPORT='5432'; $env:PGUSER='postgres.ohdeykbkgimvwstkwuuf'; $env:PGDATABASE='postgres'; $env:PGSSLMODE='require'`
4. Supabase CLI вошёл в аккаунт: `supabase login` (если ещё не).

## 1. Настройки Auth (Dashboard → Authentication) — проверить, менять только при расхождении

| Настройка | Нужно | Почему |
|---|---|---|
| Providers → Email | **включён** | вход по ID и ключу = вход по паролю |
| Allow anonymous sign-ins | **включено** | гостевой режим (библиотека) |
| Allow new users to sign up | **включено** | без него не работают анонимные входы; аккаунты учеников создаёт только функция |
| Confirm email | любое (лучше включено) | функция создаёт аккаунты уже подтверждёнными; писем нет |
| Password requirements | любые | пароль `Kn-2.` + 20 символов: строчные, заглавные, цифры, символы, 25 знаков |
| Rate limits → sign-ups and sign-ins | ≥ 30 за 5 мин на IP (по умолчанию 30) | если весь класс за одним IP школы, при 15+ учениках одновременно — поднять до 60–100 |

## 2. База данных (миграция v58)

```powershell
psql -X --single-transaction -v ON_ERROR_STOP=1 -f .\supabase\migrations\20261018120000_ff_invite_registration.sql
psql -X -f .\supabase\release\v58-check.sql
```
Ожидается: все строки `ok = t`; `invite_status` — 0 кодов. Любая ошибка — транзакция откатывается целиком,
ничего не меняется; дальше не идти.

## 3. Edge Function

```powershell
supabase functions deploy register-invite --project-ref ohdeykbkgimvwstkwuuf --no-verify-jwt
```
Секреты задавать не нужно (Supabase сам передаёт `SUPABASE_URL` и ключ service_role). Проверка (код не тратится):
```powershell
curl.exe -s -X POST https://ohdeykbkgimvwstkwuuf.supabase.co/functions/v1/register-invite -H "content-type: application/json" -d '{}'
```
Ожидается `{"error":"BAD_REQUEST"}`. Dashboard → Edge Functions: `register-invite` ACTIVE, `verify_jwt = false`.

## 4. Сайт v58

1. Слить `ff-invite-register` в `main` (pull request или fast-forward) — GitHub Pages соберёт сайт сам (1–3 мин).
2. Проверка: `https://thenikolaika1.github.io/konspekt-app/index.html` содержит `app.js?v=58`
   (кэш GitHub Pages — до 10 минут).
3. Открытые копии приложения обновятся сами при возврате в приложение (сравнение номера сборки, Service Worker
   `konspekt-v58` удаляет старый кэш).
4. Проверка на iPhone (Safari и установленное PWA), без AI: экран «Ранний доступ» с полем кода; вход по ID и ключу
   работает у ранее созданного тестового аккаунта (если есть); библиотека открывается.

## 5. Коды приглашений (только когда сайт v58 проверен)

```powershell
node tools/ff-invite-codes.mjs --count 15 --quota 1 --label "F&F 19-23.10" --expires 2026-10-24T00:00:00+03:00
```
Открытые коды — раздать лично, по одному на ученика (не сохранять в репозиторий, не пересылать в общих чатах).
SQL с хэшами — выполнить в SQL Editor. Проверка: `select * from private.invite_status();` → issued = 15.

Пробная регистрация (по желанию владельца): выпустить 1 код с меткой `smoke`, зарегистрироваться на своём телефоне,
войти на втором устройстве, затем удалить тестового пользователя (Dashboard → Authentication → Users → Delete;
право удалится каскадно, код останется погашенным).

## 6. Окно F&F 19–23.10 (вечером 18.10)

```powershell
psql -X -v ON_ERROR_STOP=1 -f .\supabase\release\v58-window.sql
```
Ожидается: начало 19.10 00:00, конец 24.10 00:00 (МСК, граница не входит), `max_total_starts = 0`.

## 7. AI — отдельное решение

Не входит в выпуск. Включение (`max_total_starts`) — только после подтверждения контроля расходов владельцем.

## Откат (по шагам, в обратном порядке)

| Что | Как | Что остаётся |
|---|---|---|
| Окно | выполнить прежние значения: `update private.ai_limits set beta_starts_at='2026-10-12 00:00+03', beta_ends_at='2026-10-19 00:00+03' where id;` | — |
| Коды | `delete from private.beta_invites where redeemed_at is null and label = 'F&F 19-23.10';` | погашенные коды и аккаунты |
| Сайт | `git revert` слияния в `main` → Pages соберёт v56; открытые копии вернутся к v56 при возврате в приложение | в v56 нет входа по ID — зарегистрированные ученики войти не смогут до повторного выпуска |
| Функция | `supabase functions delete register-invite` | — |
| База | `psql -X -v ON_ERROR_STOP=1 -f .\supabase\release\v58-rollback.sql` | выданные права `beta_invite`, аккаунты, погашенные коды |
