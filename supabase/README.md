# Supabase для Konspekt

Frontend (GitHub Pages) использует только Project URL и publishable key (`js/config.js`).
Серверные секреты хранятся только в Supabase.

## Состав

- `migrations/20260926000000_ai_notes_policies.sql` — RLS и права для `notes`, `ai_generations`, Storage `temp-pages`.
  Выполняется вручную в Dashboard → SQL Editor.
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
