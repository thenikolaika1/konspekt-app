-- =====================================================================================
-- Konspekt: права для настоящих AI-конспектов (Supabase + Edge Function analyze-pages)
--
-- ВЫПОЛНЯЕТСЯ ВРУЧНУЮ: Supabase Dashboard → SQL Editor → вставить весь файл → Run.
-- Скрипт можно запускать повторно: старые политики удаляются и создаются заново.
--
-- Итог:
--   public.notes          — клиент: читать свои; создать свою ТОЛЬКО пустой processing;
--                           переименовать (только title); удалить свою.
--                           content, status ready/failed, stage, error_code пишет только
--                           Edge Function (service role обходит RLS и эти ограничения).
--   public.ai_generations — клиент только читает свои строки; пишет только Edge Function.
--   storage temp-pages    — private; пользователь работает только с файлами в папке
--                           {auth.uid()}/…  (первый сегмент пути = его id).
-- Закладки (bookmarks, bookmark_notes) этот скрипт не меняет.
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- 1. public.notes
-- -------------------------------------------------------------------------------------

alter table public.notes enable row level security;

-- Удаляем ВСЕ существующие политики notes (созданные ранее «владелец может всё»)
-- и создаём более узкие ниже.
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'notes' loop
    execute format('drop policy %I on public.notes', p.policyname);
  end loop;
end $$;

-- Чтение: только свои конспекты.
create policy "notes: select own"
  on public.notes for select to authenticated
  using ((select auth.uid()) = user_id);

-- Создание: только своя note, только в начальном состоянии генерации, без content.
create policy "notes: insert own processing"
  on public.notes for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and status = 'processing'
    and coalesce(stage, 'uploading') = 'uploading'
    and content is null
    and error_code is null
  );

-- Изменение: только свои строки; какие столбцы — ограничено правами ниже (только title).
create policy "notes: update own title"
  on public.notes for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Удаление: только свои конспекты.
create policy "notes: delete own"
  on public.notes for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Права на столбцы: браузер может вставить только эти поля и изменить только title.
-- status/stage/error_code/content/preview/subject/schema_version после создания меняет
-- только Edge Function.
revoke all on public.notes from anon;
revoke insert, update on public.notes from authenticated;
grant select, delete on public.notes to authenticated;
grant insert (id, user_id, status, stage, title) on public.notes to authenticated;
grant update (title) on public.notes to authenticated;


-- -------------------------------------------------------------------------------------
-- 2. public.ai_generations — только чтение своих строк
-- -------------------------------------------------------------------------------------

alter table public.ai_generations enable row level security;

drop policy if exists "ai_generations: select own" on public.ai_generations;
create policy "ai_generations: select own"
  on public.ai_generations for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.ai_generations from anon;
revoke insert, update, delete on public.ai_generations from authenticated;
grant select on public.ai_generations to authenticated;


-- -------------------------------------------------------------------------------------
-- 3. Storage: private bucket temp-pages, путь {auth.uid()}/{note_id}/{имя файла}
-- -------------------------------------------------------------------------------------

-- Bucket остаётся private; лимит 5 MB и только изображения (фото уменьшаются в браузере до ~0.3–1 MB).
update storage.buckets
   set public = false,
       file_size_limit = 5242880,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'temp-pages';

drop policy if exists "temp-pages: insert own folder" on storage.objects;
drop policy if exists "temp-pages: select own folder" on storage.objects;
drop policy if exists "temp-pages: delete own folder" on storage.objects;

-- Загрузка: только в свою папку.
create policy "temp-pages: insert own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'temp-pages'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Чтение и список файлов: только своя папка (нужно Edge Function при чтении от имени пользователя
-- и приложению для повтора генерации).
create policy "temp-pages: select own folder"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'temp-pages'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Удаление: только своя папка (уборка после удаления конспекта).
create policy "temp-pages: delete own folder"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'temp-pages'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
-- Политики UPDATE нет: перезапись файлов не нужна (каждая загрузка — новое случайное имя).


-- -------------------------------------------------------------------------------------
-- 4. Проверка (необязательно): ограничения CHECK на notes и ai_generations.
-- Edge Function пишет notes.stage: uploading | analyzing | done | failed
-- и ai_generations.status: success | failed. Если CHECK запрещает эти значения —
-- пришлите вывод этого запроса.
-- -------------------------------------------------------------------------------------
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid in ('public.notes'::regclass, 'public.ai_generations'::regclass)
   and contype = 'c';
