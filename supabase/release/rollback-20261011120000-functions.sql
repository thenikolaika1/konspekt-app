-- ОТКАТ №10.2: вернуть функции F&F к состоянию production на 2026-10-12 (до миграции 20261011120000).
-- Запускать в Supabase SQL Editor только с разрешения владельца, после отключения AI.
-- Не удаляет данные. private.ai_limits и private.entitlement_active() остаются (на них ссылаются отчёты аналитики),
-- но start_text_generation перестаёт их проверять: лимиты 4 страниц / окна / бюджета не действуют.
-- После отката analyze-pages должна быть v19 (вызывает функцию с 4 аргументами).
begin;
drop function if exists public.start_text_generation(uuid, uuid, integer, integer, integer);
CREATE OR REPLACE FUNCTION public.start_text_generation(p_user_id uuid, p_note_id uuid, p_stale_seconds integer DEFAULT 300, p_lease_seconds integer DEFAULT 600)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_note    record;
  v_quota   integer;
  v_state   text;
  v_used    integer;
  v_reserved integer;
  v_op      text := p_note_id::text;
begin
  if p_user_id is null or p_note_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if p_stale_seconds is null or p_lease_seconds is null
     or p_stale_seconds not between 60 and 3600 or p_lease_seconds not between 60 and 3600 then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;

  -- 1. note: строго по очереди для одной note
  select n.user_id, n.status, n.stage, n.updated_at into v_note
    from public.notes n where n.id = p_note_id
     for update;
  if not found or v_note.user_id <> p_user_id then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_note.status = 'ready' then
    return jsonb_build_object('result', 'ready', 'access', private.access_json(p_user_id, 'text_generation'));
  end if;
  -- захват как в v18: failed, processing без stage / не analyzing, «зависший» analyzing
  if not (v_note.status = 'failed'
          or (v_note.status = 'processing'
              and (v_note.stage is null
                   or v_note.stage <> 'analyzing'
                   or v_note.updated_at < pg_catalog.now() - pg_catalog.make_interval(secs => p_stale_seconds)))) then
    return jsonb_build_object('result', 'already_processing');
  end if;

  -- 2. право пользователя: все операции пользователя — строго по очереди
  select e.quota into v_quota
    from private.user_entitlements e
   where e.user_id = p_user_id and e.resource = 'text_generation'
     for update;
  if not found then
    return jsonb_build_object('result', 'no_access');
  end if;

  select l.state into v_state
    from private.usage_ledger l
   where l.user_id = p_user_id and l.resource = 'text_generation' and l.op_key = v_op;
  if v_state = 'consumed' then
    return jsonb_build_object('result', 'already_consumed', 'access', private.access_json(p_user_id, 'text_generation'));
  end if;

  -- 3. лимит: успешные + чужие активные резервы (свой прежний резерв этой же note не считается)
  select c.used, c.reserved into v_used, v_reserved
    from private.usage_counts(p_user_id, 'text_generation', v_op) c;
  if v_used + v_reserved >= v_quota then
    update private.user_entitlements
       set blocked_attempts = blocked_attempts + 1, last_blocked_at = pg_catalog.now(), updated_at = pg_catalog.now()
     where user_id = p_user_id and resource = 'text_generation';
    return jsonb_build_object('result', 'limit_reached', 'access', private.access_json(p_user_id, 'text_generation'));
  end if;

  -- 4. резерв: новая строка или повтор той же операции (released / просроченный reserved)
  insert into private.usage_ledger as l (user_id, resource, op_key, note_id, state, reserved_at, expires_at)
  values (p_user_id, 'text_generation', v_op, p_note_id, 'reserved', pg_catalog.now(),
          pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds))
  on conflict (user_id, resource, op_key) do update
     set state        = 'reserved',
         note_id      = excluded.note_id,
         attempts     = l.attempts + 1,
         reserved_at  = excluded.reserved_at,
         expires_at   = excluded.expires_at,
         finalized_at = null
   where l.state <> 'consumed';

  -- 5. захват note (как в v18)
  update public.notes
     set status = 'processing', stage = 'analyzing', error_code = null, updated_at = pg_catalog.now()
   where id = p_note_id;

  return jsonb_build_object('result', 'started', 'access', private.access_json(p_user_id, 'text_generation'));
end
$function$
;
revoke all on function public.start_text_generation(uuid, uuid, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.start_text_generation(uuid, uuid, integer, integer) to service_role;
CREATE OR REPLACE FUNCTION public.get_my_access()
 RETURNS TABLE(resource text, plan text, quota integer, used integer, reserved integer, remaining integer, available integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select e.resource, e.plan, e.quota, c.used, c.reserved,
         greatest(e.quota - c.used, 0),
         greatest(e.quota - c.used - c.reserved, 0)
  from private.user_entitlements e
  cross join lateral private.usage_counts(e.user_id, e.resource) c
  where e.user_id = auth.uid()
$function$
;
revoke all on function public.get_my_access() from public, anon, authenticated, service_role;
grant execute on function public.get_my_access() to authenticated;
commit;
