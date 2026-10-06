# Supabase для Konspekt

Frontend (GitHub Pages) использует только Project URL и publishable key (`js/config.js`).
Серверные секреты хранятся только в Supabase.

## Состав

- `migrations/20260926000000_ai_notes_policies.sql` — RLS и права для `notes`, `ai_generations`, Storage `temp-pages`.
  Выполняется вручную в Dashboard → SQL Editor.
- `migrations/20261006120000_ff_access_foundation.sql` — Friends & Family: ранний доступ и серверный учёт
  AI-генераций (схема `private`, RPC `get_my_access`, `redeem_beta_invite`, `start_text_generation`).
  Только добавляет объекты; выполняется один раз в SQL Editor целиком (одной транзакцией).
- `functions/analyze-pages/` — Edge Function: фото из `temp-pages` → Z.AI GLM-4.6V-Flash → `notes.content`.
  - `index.ts` — авторизация, проверки, запуск генерации, запись результата;
  - `prompt.ts` — промпт модели;
  - `study-content.ts` — серверная валидация StudyContent v1 (порт `js/study-content.js`).

## Секреты функции

- `ZAI_API_KEY` — Dashboard → Edge Functions → Secrets (вручную, в репозиторий не попадает).
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` — Supabase передаёт функции сам.

## Деплой функции

CLI (из корня репозитория):

```
supabase functions deploy analyze-pages --project-ref ohdeykbkgimvwstkwuuf --no-verify-jwt
```

`--no-verify-jwt`: функция сама проверяет JWT пользователя (`auth.getUser`) и без него отвечает 401;
так она работает и с новыми ключами/JWT signing keys.

Dashboard: Edge Functions → Deploy a new function → Via Editor → имя `analyze-pages`,
три файла из `functions/analyze-pages/` с теми же именами; в настройках функции выключить
«Verify JWT with legacy secret».

## Friends & Family: администрирование доступа

Источник истины — `private.user_entitlements` (quota у каждого пользователя своя) и `private.usage_ledger`
(одна строка на операцию: reserved → consumed | released). Числа лимита в коде нет.

- Выпустить коды (локально, открытые коды в SQL не попадают):
  `node tools/ff-invite-codes.mjs --count 5 --quota 5 --label "F&F"` → раздать коды, выполнить напечатанный SQL.
  Новые коды можно выпускать с другим quota — уже активированные права это не меняет.
- Квота конкретного пользователя (в том числе свой тестовый доступ):
  `select private.admin_set_entitlement('<user_id>', 10);`
- Поднять всем BETA не ниже N: `select private.admin_raise_beta_quota(10);` (только повышает).
- Доступ пользователя: `select * from private.user_entitlements where user_id = '<user_id>';`
  и `select state, count(*) from private.usage_ledger where user_id = '<user_id>' group by 1;`
