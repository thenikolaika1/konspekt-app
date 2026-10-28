-- Откат v62 → v61.3 (одной транзакцией). Применять только по решению владельца, после резервной копии.
-- Перед откатом вернуть клиента v61.3 на GitHub Pages: клиент v62 без get_library_paragraph библиотеку не покажет.
-- Что делает: убирает функции v62 и возвращает функции v61.3 (тексты ниже — без изменений из
-- 20261026120000_owner_panel.sql); удаляет private.library_paragraphs вместе с текстами (исходник — у владельца
-- вне репозитория); тариф premium выключается, а не удаляется (на него ссылаются выдачи); выдачи, ученики,
-- заметки, генерации и аналитика не трогаются; бюджет ИИ (max_total_starts) не меняется.
-- Повторный запуск: на базе без v62 остановится на первой проверке и ничего не изменит.
begin;
do $$
begin
  if to_regclass('private.library_paragraphs') is null
     or to_regprocedure('private.start_text_generation_v2_base(uuid, uuid, integer, integer, integer)') is null then
    raise exception 'v62 не применена — откатывать нечего';
  end if;
end $$;

drop function public.owner_set_budget(text, uuid, integer, integer);
drop function public.owner_extend(text, uuid, text, integer, integer, text, timestamptz, boolean);
drop function public.owner_grant(text, uuid, text, integer, integer, text, boolean);
drop function private.panel_budget_check(integer);
drop function private.panel_terms(integer, integer);
drop function public.start_text_generation_v2(uuid, uuid, integer, integer, integer);
alter function private.start_text_generation_v2_base(uuid, uuid, integer, integer, integer) set schema public;
alter function public.start_text_generation_v2_base(uuid, uuid, integer, integer, integer) rename to start_text_generation_v2;
grant execute on function public.start_text_generation_v2(uuid, uuid, integer, integer, integer) to service_role;
drop function private.panel_ai_state();
alter function private.panel_ai_state_base() rename to panel_ai_state;
drop function private.budget_state();
drop function private.owner_reserve_left();
drop function private.premium_obligations();
drop function public.get_library_paragraph(text, text, text);
drop table private.library_paragraphs;
update private.plans set active = false, updated_at = now() where code = 'premium';
alter table private.access_settings drop column budget_warn_percent, drop column owner_reserve_starts,
  drop column budget_reserve_factor;

-- ===== функции v61.3 (из 20261026120000_owner_panel.sql) =====
create or replace function public.owner_preview(p_session text, p_kn_id text, p_action text, p_days integer default null,
                                     p_ai_quota integer default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c     record;
  v_kn    text := private.panel_kn_input(p_kn_id);
  v_uid   uuid;
  v_t     record;
  v_start timestamptz;
  v_per   jsonb;
begin
  if not private.panel_post_only() then
    return jsonb_build_object('error', 'METHOD_NOT_ALLOWED');
  end if;
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  if v_kn is null then
    return jsonb_build_object('error', 'INVALID_ID');
  end if;
  v_uid := private.panel_user_by_kn(v_kn);
  if v_uid is null then
    return jsonb_build_object('error', 'USER_NOT_FOUND');
  end if;
  v_per := private.panel_paid_periods(v_uid);
  if p_action = 'revoke' then
    if jsonb_array_length(v_per) = 0 then
      return jsonb_build_object('error', 'NOTHING_TO_REVOKE');
    end if;
    return jsonb_build_object('action', 'revoke', 'kn_id', v_kn, 'periods', v_per, 'periods_count', jsonb_array_length(v_per),
                              'access', private.access_state(v_uid), 'server_now', pg_catalog.now());
  end if;
  if p_action not in ('grant', 'extend') then
    return jsonb_build_object('error', 'INVALID_INPUT');
  end if;
  begin
    select * into v_t from private.admin_terms(null, p_days, p_ai_quota);
  exception when others then
    return private.panel_error(sqlstate, sqlerrm);
  end;
  if p_action = 'grant' then
    if jsonb_array_length(v_per) > 0 then
      return jsonb_build_object('error', 'ALREADY_ACTIVE', 'periods', v_per);
    end if;
    v_start := pg_catalog.now();
  else
    if not exists (select 1 from private.access_grants g where g.user_id = v_uid and g.kind = 'paid') then
      return jsonb_build_object('error', 'NO_PAID_YET');
    end if;
    v_start := private.panel_extend_start(v_uid);
  end if;
  return jsonb_build_object(
    'action', p_action, 'kn_id', v_kn, 'days', v_t.days, 'ai_quota', v_t.ai_quota,
    'starts_at', v_start, 'ends_at', v_start + pg_catalog.make_interval(days => v_t.days),
    -- продление встык к действующему сроку; иначе — с момента подтверждения
    'starts_after_current', v_start > pg_catalog.now() + interval '1 second',
    'periods', v_per, 'access', private.access_state(v_uid), 'server_now', pg_catalog.now());
end
$$;

-- Ошибка операции → понятный код (сообщения функций admin_* — без секретов; свои коды KN010…).
create or replace function private.panel_error(p_state text, p_message text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('error',
           case p_state when '22023' then 'INVALID_INPUT' when 'P0002' then 'NOT_FOUND'
                        when '23505' then 'ALREADY_ACTIVE' when '23514' then 'INVALID_INPUT'
                        when 'KN010' then 'STATE_CHANGED' when 'KN011' then 'NO_PAID_YET' when 'KN012' then 'NOTHING_TO_REVOKE'
                        when 'KN013' then 'INVALID_ID' when 'KN014' then 'USER_NOT_FOUND' when 'KN016' then 'DAILY_LIMIT'
                        when 'KN017' then 'INVITE_NOT_FOUND' when 'KN018' then 'ALREADY_USED' when 'KN019' then 'ALREADY_REVOKED'
                        when 'KN020' then 'ALREADY_EXPIRED' when 'KN021' then 'IN_PROGRESS'
                        else 'SERVER_ERROR' end,
           'message', case when p_state in ('22023', 'P0002', '23505', '23514') then p_message end)
$$;

create function public.owner_grant(p_session text, p_request_id uuid, p_kn_id text, p_days integer, p_ai_quota integer,
                                   p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c   record;
  v_uid uuid;
  v_t   record;
  v_r   jsonb;
  v_g   jsonb;
begin
  if not private.panel_post_only() then
    return jsonb_build_object('error', 'METHOD_NOT_ALLOWED');
  end if;
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  v_r := private.panel_request(p_request_id, v_c.o_uid, 'grant',
           jsonb_build_object('kn', p_kn_id, 'days', p_days, 'ai_quota', p_ai_quota, 'note', p_note));
  if v_r is not null then
    return v_r;
  end if;
  begin
    select * into v_t from private.panel_target(p_kn_id);
    v_uid := v_t.o_uid;
    v_g := private.admin_grant(v_t.o_kn, null, p_days, p_ai_quota, nullif(pg_catalog.btrim(p_note), ''), 'panel:' || v_c.o_kn);
    v_r := jsonb_build_object('result', 'granted', 'kn_id', v_t.o_kn,
             'grant', (select jsonb_build_object('starts_at', g.starts_at, 'ends_at', g.ends_at, 'ai_quota', g.ai_quota)
                         from private.access_grants g where g.id = (v_g ->> 'grant_id')::uuid),
             'access', private.access_state(v_t.o_uid));
  exception when others then
    v_r := private.panel_error(sqlstate, sqlerrm);
    perform private.panel_refused(v_uid, 'grant', v_r);
  end;
  return private.panel_request_done(p_request_id, v_r);
end
$$;

create function public.owner_extend(p_session text, p_request_id uuid, p_kn_id text, p_days integer, p_ai_quota integer,
                                    p_note text default null, p_expect_starts_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c     record;
  v_uid uuid;
  v_t     record;
  v_r     jsonb;
  v_g     jsonb;
  v_start timestamptz;
begin
  if not private.panel_post_only() then
    return jsonb_build_object('error', 'METHOD_NOT_ALLOWED');
  end if;
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  v_r := private.panel_request(p_request_id, v_c.o_uid, 'extend',
           jsonb_build_object('kn', p_kn_id, 'days', p_days, 'ai_quota', p_ai_quota, 'note', p_note, 'expect', p_expect_starts_at));
  if v_r is not null then
    return v_r;
  end if;
  begin
    select * into v_t from private.panel_target(p_kn_id);
    v_uid := v_t.o_uid;
    perform private.admin_lock(v_t.o_uid);
    if not exists (select 1 from private.access_grants g where g.user_id = v_t.o_uid and g.kind = 'paid') then
      raise exception 'NO_PAID_YET' using errcode = 'KN011';
    end if;
    -- подтверждение относится к тому, что владелец видел: встык к сроку с концом X — или «с этого момента» (NULL)
    v_start := private.panel_extend_start(v_t.o_uid);
    if (v_start > pg_catalog.now() + interval '1 second') then
      if p_expect_starts_at is null or abs(extract(epoch from v_start - p_expect_starts_at)) > 1 then
        raise exception 'STATE_CHANGED' using errcode = 'KN010';
      end if;
    elsif p_expect_starts_at is not null and p_expect_starts_at > pg_catalog.now() then
      raise exception 'STATE_CHANGED' using errcode = 'KN010';
    end if;
    v_g := private.admin_extend(v_t.o_kn, null, p_days, p_ai_quota, nullif(pg_catalog.btrim(p_note), ''), 'panel:' || v_c.o_kn);
    v_r := jsonb_build_object('result', 'extended', 'kn_id', v_t.o_kn,
             'grant', (select jsonb_build_object('starts_at', g.starts_at, 'ends_at', g.ends_at, 'ai_quota', g.ai_quota)
                         from private.access_grants g where g.id = (v_g ->> 'grant_id')::uuid),
             'access', private.access_state(v_t.o_uid));
  exception when others then
    v_r := private.panel_error(sqlstate, sqlerrm);
    perform private.panel_refused(v_uid, 'extend', v_r);
  end;
  return private.panel_request_done(p_request_id, v_r);
end
$$;

revoke all on function private.panel_error(text, text) from public, anon, authenticated, service_role;
revoke all on function
  public.owner_preview(text, text, text, integer, integer),
  public.owner_grant(text, uuid, text, integer, integer, text),
  public.owner_extend(text, uuid, text, integer, integer, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function
  public.owner_preview(text, text, text, integer, integer),
  public.owner_grant(text, uuid, text, integer, integer, text),
  public.owner_extend(text, uuid, text, integer, integer, text, timestamptz)
  to authenticated;
commit;
