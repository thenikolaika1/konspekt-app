-- v34.4 / релиз v66 (подготовлено, в production НЕ применено): ограничение массового скачивания готовых конспектов библиотеки.
--
-- Проблема: public.get_library_paragraph правильно проверяет доступ (владелец / пробный период / Premium), но не
-- ограничивает частоту. Ученик с доступом мог скриптом получить все параграфы библиотеки за минуту.
-- Решение: не больше 20 НОВЫХ параграфов за час и 60 за сутки на одного ученика. Параграф, открытый за последние
-- сутки, открывается повторно без ограничений (перечитывание и возврат назад не считаются). Владелец — без ограничений.
-- Сверх лимита — {"error":"RATE_LIMITED","retry_after":секунды}; текст не выдаётся. Журнал хранит только кто и какой
-- параграф открыл (без текста), доступен только серверу (RLS без политик, прав у ролей API нет).
--
-- Что не меняется: проверка метода POST, авторизации и доступа, формат ответа, права на функцию, сами тексты.
-- Повторное применение безопасно. Откат — в конце файла (закомментирован).
begin;

create table if not exists private.library_reads (
  user_id      uuid        not null,
  subject_id   text        not null,
  book_id      text        not null,
  paragraph_id text        not null,
  read_at      timestamptz not null default now(),
  primary key (user_id, subject_id, book_id, paragraph_id)
);
create index if not exists library_reads_user_time on private.library_reads (user_id, read_at);
alter table private.library_reads enable row level security;
revoke all on private.library_reads from public, anon, authenticated, service_role;

create or replace function public.get_library_paragraph(p_subject text, p_book text, p_paragraph text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_uid  uuid := auth.uid();
  v_a    jsonb;
  v_c    jsonb;
  v_last timestamptz;
  v_hour int;
  v_day  int;
  c_per_hour constant int := 20;
  c_per_day  constant int := 60;
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
  -- v34.4: частота новых параграфов (владелец — без ограничений)
  if v_a ->> 'status' <> 'owner' then
    -- запросы одного ученика проверяются по очереди: два одновременных запроса не проскочат лимит вдвоём
    perform pg_advisory_xact_lock(hashtextextended('library_reads:' || v_uid::text, 0));
    select r.read_at into v_last from private.library_reads r
     where r.user_id = v_uid and r.subject_id = p_subject and r.book_id = p_book and r.paragraph_id = p_paragraph;
    if v_last is null or v_last < now() - interval '24 hours' then
      select count(*) filter (where r.read_at >= now() - interval '1 hour'), count(*)
        into v_hour, v_day
        from private.library_reads r
       where r.user_id = v_uid and r.read_at >= now() - interval '24 hours';
      if v_hour >= c_per_hour or v_day >= c_per_day then
        return jsonb_build_object('error', 'RATE_LIMITED', 'retry_after',
          case when v_hour >= c_per_hour then 3600 else 86400 end);
      end if;
      insert into private.library_reads (user_id, subject_id, book_id, paragraph_id, read_at)
      values (v_uid, p_subject, p_book, p_paragraph, now())
      on conflict (user_id, subject_id, book_id, paragraph_id) do update set read_at = excluded.read_at;
    end if;
  end if;
  return jsonb_build_object('content', v_c, 'access_status', v_a ->> 'status');
end
$function$;

-- права на функцию — как были (create or replace их сохраняет; повторяем явно)
revoke all on function public.get_library_paragraph(text, text, text) from public, anon;
grant execute on function public.get_library_paragraph(text, text, text) to authenticated;

commit;

-- Откат: 20261110120000_v34_4_library_rate_limit.rollback.sql (проверен в tests/v66r/rate-limit.test.sh).
