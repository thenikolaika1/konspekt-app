-- =====================================================================================
-- ОТКАТ миграции 20261011120500_ff_invite_code_normalize (кириллические буквы-двойники в кодах).
--
-- Возвращает private.invite_code_hash и public.redeem_beta_invite к определениям из
-- 20261006120000_ff_access_foundation (тексты ниже скопированы оттуда дословно, программно) и удаляет
-- private.invite_code_normalize. Данные НЕ меняются: коды, права и журнал остаются как есть.
-- Латинские коды после отката работают как раньше (их хэш одинаков до и после); коды, набранные
-- кириллицей, снова будут отклоняться. CREATE OR REPLACE сохраняет права на функции.
--
-- Запуск (одной транзакцией, остановка при первой ошибке):
--   psql --single-transaction -v ON_ERROR_STOP=1 -f supabase/release/rollback-20261011120500.sql
-- Миграции 20261011120000 и аналитики откат не трогает. Применить нормализацию заново можно
-- тем же файлом миграции 20261011120500.
-- =====================================================================================

-- защита: откатывать только если миграция действительно применена
do $do$
begin
  if to_regprocedure('private.invite_code_normalize(text)') is null then
    raise exception 'Миграция 20261011120500 не применена (нет private.invite_code_normalize) — откатывать нечего';
  end if;
end
$do$;

-- 1. Нормализация кода: регистр, пробелы и дефисы не важны (как в 20261006120000).
create or replace function private.invite_code_hash(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')), 'UTF8')), 'hex')
$$;

-- 2. Активация кода (как в 20261006120000).
create or replace function public.redeem_beta_invite(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_quota integer;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  -- нормализованный код короче 8 символов не бывает (коды выпускает администратор, ≥ 12 символов)
  if p_code is null or length(p_code) > 64
     or length(pg_catalog.regexp_replace(p_code, '[^0-9A-Za-z]', '', 'g')) < 8 then
    return jsonb_build_object('result', 'invalid');
  end if;

  -- активации одного пользователя — по очереди (два кода одновременно не дадут два права)
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ff_redeem:' || v_uid::text, 0));

  if exists (select 1 from private.user_entitlements where user_id = v_uid and resource = 'text_generation') then
    -- право уже есть: код не тратим
    return jsonb_build_object('result', 'already_active', 'access', private.access_json(v_uid, 'text_generation'));
  end if;

  -- атомарное погашение: при одновременной активации одного кода строку получит ровно один пользователь
  update private.beta_invites
     set redeemed_by = v_uid, redeemed_at = pg_catalog.now()
   where code_hash = private.invite_code_hash(p_code)
     and redeemed_at is null
     and (expires_at is null or expires_at > pg_catalog.now())
  returning quota into v_quota;

  if not found then
    return jsonb_build_object('result', 'invalid');
  end if;

  insert into private.user_entitlements (user_id, resource, plan, quota, source)
  values (v_uid, 'text_generation', 'beta', v_quota, 'beta_invite');

  return jsonb_build_object('result', 'activated', 'access', private.access_json(v_uid, 'text_generation'));
end
$$;

-- 3. Функция нормализации больше не используется
drop function private.invite_code_normalize(text);
