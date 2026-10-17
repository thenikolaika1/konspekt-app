-- Konspekt v58: откат миграции 20261018120000 (только по решению владельца; регистрации в процессе будут прерваны).
-- Выданные права beta_invite и погашенные коды НЕ удаляются. Edge Function register-invite удалить отдельно
-- (supabase functions delete register-invite) или оставить — без функций БД она отвечает TEMPORARY.
begin;
drop function public.register_invite_begin(text, text, text);
drop function public.register_invite_finish(text, uuid, uuid);
drop function private.invite_status();
drop function private.kn_email(text);
drop table private.invite_registrations;
drop table private.register_attempts;
-- прежняя активация кода текущим пользователем (тело из 20261011120500)
create or replace function public.redeem_beta_invite(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_quota integer;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if p_code is null or length(p_code) > 64
     or length(private.invite_code_normalize(p_code)) < 8 then
    return jsonb_build_object('result', 'invalid');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ff_redeem:' || v_uid::text, 0));
  if exists (select 1 from private.user_entitlements where user_id = v_uid and resource = 'text_generation') then
    return jsonb_build_object('result', 'already_active', 'access', private.access_json(v_uid, 'text_generation'));
  end if;
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
commit;
