-- Откат v66.6: возвращает обе функции к версии, проверенной в production 08.11.2026.
begin;
do $g$
declare b text; k text;
begin
  select md5(replace(prosrc, E'\r', '')) into b from pg_proc where oid = 'private.start_text_generation_v2_base(uuid,uuid,integer,integer,integer)'::regprocedure;
  select md5(replace(prosrc, E'\r', '')) into k from pg_proc where oid = 'private.ai_breaker()'::regprocedure;
  if b not in ('fea6ca6007e0f7ecc839dc86c50a5cb5', '24277196d83882dcce9e85f09072b5c5') or k not in ('7e8d16ab1218788b7be53df491f8a034', 'a2c29d91d47b738f8bc36cff21b4002f') then
    raise exception 'v66.6: функции в базе не совпадают с проверенными (base %, breaker %) — ничего не изменено', b, k;
  end if;
end $g$;
CREATE OR REPLACE FUNCTION private.start_text_generation_v2_base(p_user_id uuid, p_note_id uuid, p_stale_seconds integer DEFAULT 300, p_lease_seconds integer DEFAULT 600, p_page_count integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_note  record;
  v_lim   record;
  v_g     private.access_grants;
  v_u     record;
  v_state text;
  v_set   private.access_settings;
  v_open  integer;
  v_r     jsonb;
  v_op    text := p_note_id::text;
begin
  if p_user_id is null or p_note_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if p_stale_seconds is null or p_lease_seconds is null
     or p_stale_seconds not between 60 and 3600 or p_lease_seconds not between 60 and 3600
     or (p_page_count is not null and p_page_count < 1) then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;

  -- выдач нет — прежняя проверка без изменений (F&F, служебные анонимные аккаунты); общий автостоп и журнал
  -- запусков — и для них (их неудачи тоже тратят общий бюджет)
  if not exists (select 1 from private.access_grants g where g.user_id = p_user_id) then
    if private.ai_breaker() then
      -- отказ старой проверки (access_expired, limit_reached…) — как раньше; разрешённый ею запуск отменяется целиком
      begin
        v_r := public.start_text_generation(p_user_id, p_note_id, p_stale_seconds, p_lease_seconds, p_page_count);
        if v_r ->> 'result' = 'started' then
          raise exception 'ai_unavailable' using errcode = 'KN001';
        end if;
        return v_r;
      exception when sqlstate 'KN001' then
        return jsonb_build_object('result', 'ai_unavailable');
      end;
    end if;
    v_r := public.start_text_generation(p_user_id, p_note_id, p_stale_seconds, p_lease_seconds, p_page_count);
    if v_r ->> 'result' = 'started' then
      update private.generation_starts s
         set outcome = 'failed', finished_at = pg_catalog.now()
       where s.user_id = p_user_id and s.op_key = v_op and s.outcome is null;
      insert into private.generation_starts (user_id, grant_id, op_key) values (p_user_id, null, v_op);
    end if;
    return v_r;
  end if;

  -- 1. note: строго по очереди для одной note (как в start_text_generation)
  select n.user_id, n.status, n.stage, n.updated_at into v_note
    from public.notes n where n.id = p_note_id
     for update;
  if not found or v_note.user_id <> p_user_id then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_note.status = 'ready' then
    return jsonb_build_object('result', 'ready', 'access', private.access_state(p_user_id));
  end if;
  if not (v_note.status = 'failed'
          or (v_note.status = 'processing'
              and (v_note.stage is null
                   or v_note.stage <> 'analyzing'
                   or v_note.updated_at < pg_catalog.now() - pg_catalog.make_interval(secs => p_stale_seconds)))) then
    return jsonb_build_object('result', 'already_processing');
  end if;

  -- 2. пользователь: все его генерации и операции владельца с его доступом — строго по очереди
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('konspekt_access:' || p_user_id::text, 0));

  -- 3. общие настройки AI: все запуски — по очереди (бюджет и одновременные генерации)
  select * into v_lim from private.ai_limits for update;
  if not found then
    return jsonb_build_object('result', 'ai_paused');
  end if;
  if p_page_count is not null and p_page_count > v_lim.max_pages then
    return jsonb_build_object('result', 'too_many_pages', 'max_pages', v_lim.max_pages);
  end if;

  -- 4. действующая выдача (срок — по часам сервера)
  select * into v_g from private.active_grant(p_user_id);
  if v_g.id is null then
    return jsonb_build_object('result', 'access_expired', 'access', private.access_state(p_user_id));
  end if;

  select l.state into v_state
    from private.usage_ledger l
   where l.user_id = p_user_id and l.resource = 'text_generation' and l.op_key = v_op;
  if v_state = 'consumed' then
    return jsonb_build_object('result', 'already_consumed', 'access', private.access_state(p_user_id));
  end if;

  -- 5. лимит генераций срока (у владельца его нет): успешные + чужие активные резервы
  if v_g.ai_quota is not null then
    select * into v_u from private.grant_usage(v_g.id, v_op);
    if v_u.used + v_u.reserved >= v_g.ai_quota then
      return jsonb_build_object('result', 'limit_reached', 'access', private.access_state(p_user_id));
    end if;
  end if;
  -- 5а. неудачи (и у владельца): генерацию не тратят и срок не закрывают — только паузы. Идущие запуски (итога ещё нет)
  --     считаются возможными неудачами любого вида: параллельные запросы предел не обходят
  select * into v_set from private.access_settings limit 1;
  select count(*) into v_open
    from private.generation_starts s
   where s.user_id = p_user_id and s.outcome is null and s.started_at >= pg_catalog.now() - interval '10 minutes';
  if private.failed_starts(p_user_id, pg_catalog.now() - interval '24 hours', 'user') + v_open >= v_set.max_user_errors_per_day then
    return jsonb_build_object('result', 'retry_limit', 'access', private.access_state(p_user_id));
  end if;
  if private.failed_starts(p_user_id, pg_catalog.now() - interval '24 hours', 'tech') + v_open >= v_set.max_tech_errors_per_day then
    return jsonb_build_object('result', 'daily_limit', 'access', private.access_state(p_user_id));
  end if;
  if private.failed_starts(p_user_id, pg_catalog.now() - pg_catalog.make_interval(mins => v_set.tech_pause_minutes), 'tech') + v_open
     >= v_set.tech_pause_after then
    return jsonb_build_object('result', 'cooldown', 'retry_after_minutes', v_set.tech_pause_minutes, 'access', private.access_state(p_user_id));
  end if;
  -- все запуски за сутки (если задано; владельца не касается)
  if v_g.ai_quota is not null and v_set.max_starts_per_day is not null
     and (select count(*) from private.generation_starts s
           where s.user_id = p_user_id and s.started_at > pg_catalog.now() - interval '24 hours') >= v_set.max_starts_per_day then
    return jsonb_build_object('result', 'daily_limit', 'access', private.access_state(p_user_id));
  end if;

  -- 6. общие лимиты — для всех, включая владельца
  if not v_lim.ai_enabled or v_lim.total_starts >= v_lim.max_total_starts then
    return jsonb_build_object('result', 'ai_paused');
  end if;
  if private.ai_breaker() then
    return jsonb_build_object('result', 'ai_unavailable');
  end if;
  if (select count(*) from private.usage_ledger l
       where l.state = 'reserved' and l.expires_at > pg_catalog.now()
         and not (l.user_id = p_user_id and l.op_key = v_op)) >= v_lim.max_in_flight then
    return jsonb_build_object('result', 'ai_busy');
  end if;

  -- 7. резерв в счёт этой выдачи: новая строка или повтор той же операции (released / просроченный reserved)
  insert into private.usage_ledger as l (user_id, resource, op_key, note_id, state, reserved_at, expires_at, grant_id)
  values (p_user_id, 'text_generation', v_op, p_note_id, 'reserved', pg_catalog.now(),
          pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds), v_g.id)
  on conflict (user_id, resource, op_key) do update
     set state        = 'reserved',
         note_id      = excluded.note_id,
         grant_id     = excluded.grant_id,
         attempts     = l.attempts + 1,
         reserved_at  = excluded.reserved_at,
         expires_at   = excluded.expires_at,
         finalized_at = null
   where l.state <> 'consumed';
  update private.ai_limits set total_starts = total_starts + 1, updated_at = pg_catalog.now() where id;
  -- запуск в журнал запусков; незавершённый прежний запуск этой note (функция прервалась) — неудача
  update private.generation_starts s
     set outcome = 'failed', finished_at = pg_catalog.now()
   where s.user_id = p_user_id and s.op_key = v_op and s.outcome is null;
  insert into private.generation_starts (user_id, grant_id, op_key) values (p_user_id, v_g.id, v_op);

  -- 8. захват note (итог резерва фиксирует существующий триггер notes_finalize_usage: ready → списан, failed → возвращён)
  update public.notes
     set status = 'processing', stage = 'analyzing', error_code = null, updated_at = pg_catalog.now()
   where id = p_note_id;
  return jsonb_build_object('result', 'started', 'access', private.access_state(p_user_id));
end
$function$
;

CREATE OR REPLACE FUNCTION private.ai_breaker()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce((
    select (select count(*) >= c.breaker_errors and count(distinct s.user_id) >= 2
              from private.generation_starts s
             where s.started_at >= pg_catalog.now() - pg_catalog.make_interval(mins => c.breaker_minutes)
               and ((s.outcome = 'failed' and private.failure_kind(s.error_code) = 'tech')
                    or (s.outcome is null and s.started_at < pg_catalog.now() - interval '10 minutes')))
        or private.failed_starts(null, pg_catalog.now() - interval '24 hours', 'tech') >= c.breaker_errors_per_day
      from private.access_settings c), false)
$function$
;

do $g$
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'private.start_text_generation_v2_base(uuid,uuid,integer,integer,integer)'::regprocedure) <> 'fea6ca6007e0f7ecc839dc86c50a5cb5'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'private.ai_breaker()'::regprocedure) <> '7e8d16ab1218788b7be53df491f8a034' then
    raise exception 'v66.6: после замены контрольные суммы не совпали — транзакция отменена';
  end if;
end $g$;
commit;
