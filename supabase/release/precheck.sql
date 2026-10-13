-- ТОЛЬКО ЧТЕНИЕ. Проверка, что база в ожидаемом состоянии ДО применения миграций F&F.
-- Ничего не меняет; при неожиданном состоянии прерывается с понятной ошибкой (psql ON_ERROR_STOP).
do $do$
begin
  if to_regclass('private.user_entitlements') is null or to_regprocedure('private.invite_code_hash(text)') is null
     or to_regprocedure('public.redeem_beta_invite(text)') is null or to_regprocedure('public.get_my_access()') is null then
    raise exception 'PRECHECK: нет основы F&F (миграция 20261006120000) — это не та база';
  end if;
  if to_regclass('public.notes') is null or to_regclass('public.ai_generations') is null then
    raise exception 'PRECHECK: нет таблиц приложения public.notes / public.ai_generations — это не та база';
  end if;
  if to_regclass('private.ai_limits') is null
     and to_regprocedure('public.start_text_generation(uuid,uuid,integer,integer)') is null then
    raise exception 'PRECHECK: нет public.start_text_generation(uuid,uuid,integer,integer), хотя 20261011120000 не применена';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'notes_finalize_usage' and tgrelid = 'public.notes'::regclass) then
    raise exception 'PRECHECK: нет триггера notes_finalize_usage на public.notes';
  end if;
  raise notice 'PRECHECK OK: %', version();
end
$do$;
