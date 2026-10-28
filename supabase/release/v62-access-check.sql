-- Проверка доступа к закрытой библиотеке после v62 (ТОЛЬКО ЧТЕНИЕ, тексты не выводятся).
-- Для одного пользователя каждого статуса вызывает public.get_library_paragraph от его имени (как приложение: claims JWT)
-- и печатает: статус | ID | text (текст выдан) или код отказа. Ожидается: owner, trial, paid → text; expired, none → ACCESS_REQUIRED.
-- Запуск: psql DB -X -A -t -f supabase/release/v62-access-check.sql
begin transaction read only;
with p as (select subject_id, book_id, paragraph_id from private.library_paragraphs order by 1, 2, 3 limit 1),
     u as (
       select distinct on (st) st, id, email from (
         select (private.access_state(x.id) ->> 'status') st, x.id, x.email from auth.users x
       ) a order by st, email nulls last, id)
select u.st || '|' || coalesce(upper(replace(replace(u.email, 'id-', ''), '@id.konspekt.invalid', '')), 'гость') || '|' ||
       coalesce((select case when r ? 'content' then 'text' else r ->> 'error' end
                   from (select set_config('request.jwt.claims', json_build_object('sub', u.id, 'role', 'authenticated')::text, true)) c,
                        lateral (select public.get_library_paragraph(p.subject_id, p.book_id, p.paragraph_id) r from p) g), 'нет параграфов')
  from u order by u.st;
commit;
