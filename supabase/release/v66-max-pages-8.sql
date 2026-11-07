-- v66 (эксперимент «8 фотографий»): лимит страниц в одной генерации 4 → 8.
-- НЕ применять, пока не развёрнута analyze-pages с генерацией по частям (parts.ts) и нет разрешения владельца.
-- Порядок выпуска: 1) analyze-pages (совместима с текущим клиентом: до 4 страниц — как раньше); 2) этот файл;
-- 3) клиент v66 (MAX_PAGES = 8). Меняется только private.ai_limits.max_pages (проверка уже допускает 1–8).
begin;
update private.ai_limits set max_pages = 8, updated_at = now() where id and max_pages = 4;
select max_pages from private.ai_limits;   -- ожидается 8
commit;

-- Отмена (вернуть 4 страницы; клиент v66 тогда получит отказ TOO_MANY_PAGES на 5–8 страниц):
-- update private.ai_limits set max_pages = 4, updated_at = now() where id;
