-- Откат 20261110120000_v34_4_library_rate_limit.sql (подготовлено, в production НЕ применено).
-- Возвращает public.get_library_paragraph к телу из 20261028120000_v62_paid_library.sql (как в production до миграции;
-- в production тело то же, отличаются только переводы строк CRLF) и удаляет журнал чтений private.library_reads.
-- Что теряется: только журнал «кто какой параграф открывал» (служебный, без текстов). Конспекты, доступы, оплаты,
-- тексты библиотеки не затрагиваются. Повторный запуск безопасен.
begin;

create or replace function public.get_library_paragraph(p_subject text, p_book text, p_paragraph text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_a   jsonb;
  v_c   jsonb;
begin
  if not private.panel_post_only() then
    return jsonb_build_object('error', 'METHOD_NOT_ALLOWED');
  end if;
  if v_uid is null then
    return jsonb_build_object('error', 'UNAUTHORIZED');
  end if;
  v_a := private.access_state(v_uid);
  if coalesce(v_a ->> 'status', 'none') not in ('owner', 'paid', 'trial') then
    return jsonb_build_object('error', 'ACCESS_REQUIRED', 'access', v_a);
  end if;
  if p_subject is null or p_book is null or p_paragraph is null
     or p_subject !~ '^[a-z0-9][a-z0-9-]{0,39}$' or p_book !~ '^[a-z0-9][a-z0-9-]{0,99}$'
     or p_paragraph !~ '^[a-z0-9][a-z0-9-]{0,99}$' then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  select l.content into v_c
    from private.library_paragraphs l
   where l.subject_id = p_subject and l.book_id = p_book and l.paragraph_id = p_paragraph;
  if v_c is null then
    return jsonb_build_object('error', 'NOT_FOUND');
  end if;
  return jsonb_build_object('content', v_c, 'access_status', v_a ->> 'status');
$$;

revoke all on function public.get_library_paragraph(text, text, text) from public, anon;
grant execute on function public.get_library_paragraph(text, text, text) to authenticated;

drop table if exists private.library_reads;

commit;
