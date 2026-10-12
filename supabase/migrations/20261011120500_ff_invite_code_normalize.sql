-- =====================================================================================
-- Konspekt: Friends & Family — коды приглашений принимают кириллические буквы-двойники.
--
-- Коды выпускаются латиницей (tools/ff-invite-codes.mjs), но на телефоне с русской раскладкой
-- «KMPT» легко набрать как «КМРТ»: буквы выглядят одинаково, а хэш был другим → «Код не подошёл».
-- Теперь перед хэшированием кириллические двойники заменяются латинскими (А→A, В→B, С→C, Е→E, Н→H,
-- К→K, М→M, О→O, Р→P, Т→T, Х→X, У→Y, З→3 — заглавные и строчные). Остальное как раньше:
-- регистр, пробелы, дефисы и прочие символы не важны.
--
-- Совместимость: латинские коды дают тот же хэш, что и до миграции (замена касается только
-- кириллицы), поэтому уже выпущенные коды и private.beta_invites не меняются. Разные латинские коды
-- не могут совпасть: латиница не переписывается. Новая нормализация продублирована в
-- tools/ff-invite-codes.mjs (normalize) — они должны совпадать.
--
-- Меняются только: private.invite_code_normalize (новая), private.invite_code_hash (тело) и
-- public.redeem_beta_invite (проверка длины — после нормализации, иначе кириллица отсекалась бы раньше).
-- CREATE OR REPLACE сохраняет права на существующие функции. Окно F&F и лимиты AI не трогаются.
-- Применять только вручную, после 20261011120000 и до миграций аналитики.
-- =====================================================================================

-- Нормализованный код: только [0-9A-Z]. Двойники — до upper, чтобы строчные тоже заменялись.
create function private.invite_code_normalize(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.upper(pg_catalog.regexp_replace(
    pg_catalog.translate(coalesce(p_code, ''),
                         'АВСЕНКМОРТХУЗавсенкмортхуз',
                         'ABCEHKMOPTXY3abcehkmoptxy3'),
    '[^0-9A-Za-z]', '', 'g'))
$$;

-- Нормализация кода: регистр, пробелы, дефисы и кириллические двойники не важны
-- («knsp-7f3k q9xa» = «KNSP7F3KQ9XA» = «КNSР7F3КQ9ХА»).
create or replace function private.invite_code_hash(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(pg_catalog.convert_to(private.invite_code_normalize(p_code), 'UTF8')), 'hex')
$$;

-- Активация кода для себя. Ответ: { result: activated | already_active | invalid, access }.
-- Неверный, погашенный и просроченный код неразличимы снаружи (invalid).
-- Отличие от 20261006120000 — только проверка длины: по нормализованному коду (с учётом двойников).
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
     or length(private.invite_code_normalize(p_code)) < 8 then
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

-- Новая функция: по умолчанию никому (как остальные внутренние функции private)
revoke all on function private.invite_code_normalize(text) from public, anon, authenticated, service_role;

-- -------------------------------------------------------------------------------------
-- Откат (только вручную): вернуть тела функций из 20261006120000 и удалить нормализацию.
--   create or replace function private.invite_code_hash(p_code text) ... (тело из 20261006120000);
--   create or replace function public.redeem_beta_invite(p_code text) ... (тело из 20261006120000);
--   drop function private.invite_code_normalize(text);
-- -------------------------------------------------------------------------------------
