-- ТОЛЬКО ЧТЕНИЕ. Проверка состояния ПОСЛЕ всех пяти миграций F&F.
-- Ничего не меняет; при любом несоответствии прерывается с понятной ошибкой (psql ON_ERROR_STOP).
do $do$
declare
  l record;
  n integer;
  fails text[] := '{}';
  -- права service_role на колонки (как в production): Edge Function работает только с ними
  notes_sel  text[] := array['id','user_id','status','stage','updated_at'];
  notes_upd  text[] := array['status','stage','error_code','title','subject','preview','content','schema_version','updated_at'];
  gen_ins    text[] := array['user_id','note_id','model','page_count','input_tokens','output_tokens','estimated_cost','latency','status'];
  c text;
begin
  -- 20261011120000: настройки F&F — безопасные значения по умолчанию, AI не запустится без бюджета
  select count(*) into n from private.ai_limits;
  if n <> 1 then fails := fails || ('ai_limits: строк ' || n || ', ожидалась 1'); end if;
  select * into l from private.ai_limits limit 1;
  if not (l.ai_enabled and l.max_pages = 4 and l.max_user_starts = 3 and l.max_in_flight = 3 and l.max_total_starts = 0) then
    fails := fails || format('ai_limits: неожиданные значения (enabled=%s pages=%s user_starts=%s in_flight=%s budget=%s)',
                             l.ai_enabled, l.max_pages, l.max_user_starts, l.max_in_flight, l.max_total_starts);
  end if;
  if to_regprocedure('public.start_text_generation(uuid,uuid,integer,integer,integer)') is null then fails := fails || 'нет start_text_generation(5 аргументов)'::text; end if;
  if to_regprocedure('public.start_text_generation(uuid,uuid,integer,integer)') is not null then fails := fails || 'осталась start_text_generation(4 аргумента)'::text; end if;
  if not has_function_privilege('service_role', 'public.start_text_generation(uuid,uuid,integer,integer,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.start_text_generation(uuid,uuid,integer,integer,integer)', 'execute')
     or has_function_privilege('anon', 'public.start_text_generation(uuid,uuid,integer,integer,integer)', 'execute') then
    fails := fails || 'start_text_generation: права не те (нужно только service_role)'::text;
  end if;
  if not has_function_privilege('authenticated', 'public.get_my_access()', 'execute')
     or has_function_privilege('anon', 'public.get_my_access()', 'execute') then
    fails := fails || 'get_my_access: права не те'::text;
  end if;
  -- 20261011120500: кириллические двойники
  if to_regprocedure('private.invite_code_normalize(text)') is null then fails := fails || 'нет invite_code_normalize'::text; end if;
  if private.invite_code_hash('КМРТ-ХАЕС-ВН23') <> private.invite_code_hash('KMPT-XAEC-BH23') then
    fails := fails || 'invite_code_hash: кириллица не совпадает с латиницей'::text;
  end if;
  if not has_function_privilege('authenticated', 'public.redeem_beta_invite(text)', 'execute')
     or has_function_privilege('anon', 'public.redeem_beta_invite(text)', 'execute')
     or has_function_privilege('authenticated', 'private.invite_code_normalize(text)', 'execute')
     or has_function_privilege('anon', 'private.invite_code_normalize(text)', 'execute') then
    fails := fails || 'redeem_beta_invite / invite_code_normalize: права не те'::text;
  end if;
  -- 20261011130000–130200: аналитика закрыта, справочник 77, отчёты на месте
  if to_regprocedure('public.track(jsonb)') is null or not has_function_privilege('authenticated', 'public.track(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.track(jsonb)', 'execute') then
    fails := fails || 'track: нет функции или права не те'::text;
  end if;
  if has_schema_privilege('anon', 'analytics', 'usage') or has_schema_privilege('authenticated', 'analytics', 'usage')
     or has_schema_privilege('service_role', 'analytics', 'usage') then
    fails := fails || 'схема analytics открыта ролям API'::text;
  end if;
  select count(*) into n from analytics.catalog_paragraphs where not retired;
  if n <> 77 then fails := fails || ('справочник: ' || n || ' материалов, ожидалось 77'); end if;
  foreach c in array array['r1_users','r2_views','r3_paragraphs','r4_daily','r5_ai','r6_summary'] loop
    if to_regclass('analytics.' || c) is null then fails := fails || ('нет отчёта analytics.' || c); end if;
  end loop;
  -- ничего лишнего с существующими объектами
  if not exists (select 1 from pg_trigger where tgname = 'notes_finalize_usage' and tgrelid = 'public.notes'::regclass) then
    fails := fails || 'пропал триггер notes_finalize_usage'::text;
  end if;
  foreach c in array notes_sel loop
    if not has_column_privilege('service_role', 'public.notes', c, 'select') then fails := fails || ('service_role потерял SELECT notes.' || c); end if;
  end loop;
  foreach c in array notes_upd loop
    if not has_column_privilege('service_role', 'public.notes', c, 'update') then fails := fails || ('service_role потерял UPDATE notes.' || c); end if;
  end loop;
  foreach c in array gen_ins loop
    if not has_column_privilege('service_role', 'public.ai_generations', c, 'insert') then fails := fails || ('service_role потерял INSERT ai_generations.' || c); end if;
  end loop;

  if array_length(fails, 1) > 0 then
    raise exception E'POSTCHECK: % проблем(ы):\n - %', array_length(fails, 1), array_to_string(fails, E'\n - ');
  end if;
  raise notice 'POSTCHECK OK: 5 миграций на месте, бюджет AI = 0, окно F&F % — % (МСК), справочник 77',
    to_char(l.beta_starts_at at time zone 'Europe/Moscow', 'DD.MM HH24:MI'), to_char(l.beta_ends_at at time zone 'Europe/Moscow', 'DD.MM HH24:MI');
end
$do$;
