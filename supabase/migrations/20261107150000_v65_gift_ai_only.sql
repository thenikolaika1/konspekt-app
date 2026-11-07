-- v65: подарок «Только ИИ-генерации».
--
-- Владелец добавляет ученику N генераций ИИ к ДЕЙСТВУЮЩЕМУ доступу (пробный период, подарок или оплаченный срок):
-- лимит этой выдачи увеличивается на N (было 3 из лимита, +5 → 8). Дни, даты, тариф, другие выдачи и уже
-- использованные генерации не меняются. Генерации действуют, пока действует эта выдача, и сгорают вместе с ней —
-- по прежним правилам. Нет действующего доступа (или он F&F / владельца) — отказ: ИИ без доступа не открывается.
--
-- Только добавляет объекты: 4 функции. Таблицы, правила доступа, проверка и списание генераций, прежние функции
-- панели не меняются. Повторное применение безопасно (create or replace).
--
-- Защита: как у прочих действий панели — только POST, сессия панели владельца (private.panel_check), идемпотентность
-- по request_id (private.owner_requests), блокировка ученика (private.admin_lock), проверка бюджета ИИ под
-- блокировкой строки ai_limits, журнал private.access_log ('gift_ai') и журнал отказов.

-- План начисления: какая выдача получит генерации и что будет после. Ошибки — кодами (без исключений).
create or replace function private.panel_gift_ai_plan(p_user_id uuid, p_ai_quota integer,
                                                      out o_err text, out o_grant uuid, out o_kind text, out o_plan text,
                                                      out o_quota_before integer, out o_quota_after integer,
                                                      out o_used integer, out o_reserved integer,
                                                      out o_starts timestamptz, out o_ends timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_a jsonb;
  v_g private.access_grants;
  v_u record;
begin
  -- за один раз 1…100 генераций: подарок, а не тариф; итог выдачи — не больше 1000 (ограничение таблицы)
  if p_ai_quota is null or p_ai_quota not between 1 and 100 then
    o_err := 'GIFT_AI_INVALID';
    return;
  end if;
  v_a := private.access_state(p_user_id);
  if v_a ->> 'status' = 'owner' then
    o_err := 'GIFT_OWNER';
    return;
  end if;
  if v_a ->> 'kind' = 'legacy' and v_a ->> 'status' in ('paid', 'trial') then
    o_err := 'GIFT_MANUAL_ACCESS';
    return;
  end if;
  -- та же выдача, с которой списываются генерации прямо сейчас (private.active_grant — как при запуске ИИ)
  select * into v_g from private.active_grant(p_user_id);
  if v_g.id is null or v_g.ai_quota is null then
    o_err := 'NO_ACTIVE_ACCESS';
    return;
  end if;
  select * into v_u from private.grant_usage(v_g.id);
  o_grant := v_g.id;
  o_kind := v_g.kind;
  o_plan := v_g.plan;
  o_quota_before := v_g.ai_quota;
  o_quota_after := v_g.ai_quota + p_ai_quota;
  o_used := v_u.used;
  o_reserved := v_u.reserved;
  o_starts := v_g.starts_at;
  o_ends := v_g.ends_at;
  if o_quota_after > 1000 then
    o_err := 'GIFT_TOO_LARGE';
  end if;
end
$$;

-- Хватит ли бюджета: генерации оплаченного срока входят в резерв Premium (как при выдаче срока), подарочные и
-- пробные — сверх резерва (как при выдаче подарка). Вызывать под блокировкой строки ai_limits при начислении.
create or replace function private.panel_gift_ai_budget_check(p_kind text, p_plan text, p_quota integer)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when p_kind = 'paid' and p_plan is distinct from 'gift' then private.panel_budget_check(p_quota)
              else private.panel_gift_budget_check(p_quota) end
$$;

-- Предпросмотр для экрана подтверждения: ничего не меняет.
create or replace function public.owner_gift_ai_preview(p_session text, p_kn_id text, p_ai_quota integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c   record;
  v_kn  text := private.panel_kn_input(p_kn_id);
  v_uid uuid;
  v_p   record;
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
  select * into v_p from private.panel_gift_ai_plan(v_uid, p_ai_quota);
  if v_p.o_err is not null then
    return jsonb_build_object('error', v_p.o_err, 'access', private.access_state(v_uid));
  end if;
  return jsonb_build_object(
    'action', 'gift_ai', 'kn_id', v_kn, 'ai_quota', p_ai_quota,
    'grant_kind', v_p.o_kind, 'grant_plan', v_p.o_plan, 'starts_at', v_p.o_starts, 'ends_at', v_p.o_ends,
    'quota_before', v_p.o_quota_before, 'quota_after', v_p.o_quota_after, 'ai_used', v_p.o_used,
    'remaining_before', greatest(v_p.o_quota_before - v_p.o_used, 0),
    'remaining_after', greatest(v_p.o_quota_after - v_p.o_used, 0),
    'budget_check', private.panel_gift_ai_budget_check(v_p.o_kind, v_p.o_plan, p_ai_quota),
    'access', private.access_state(v_uid), 'server_now', pg_catalog.now());
end
$$;

-- Начисление. Повтор с тем же p_request_id возвращает прежний результат (replayed) и второй раз не начисляет.
create or replace function public.owner_gift_ai(p_session text, p_request_id uuid, p_kn_id text, p_ai_quota integer,
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
  v_p   record;
  v_b   jsonb;
  v_r   jsonb;
  v_id  uuid;
begin
  if not private.panel_post_only() then
    return jsonb_build_object('error', 'METHOD_NOT_ALLOWED');
  end if;
  select * into v_c from private.panel_check(p_session);
  if v_c.o_err is not null then
    return jsonb_build_object('error', v_c.o_err);
  end if;
  v_r := private.panel_request(p_request_id, v_c.o_uid, 'gift_ai',
           jsonb_build_object('kn', p_kn_id, 'ai_quota', p_ai_quota, 'note', p_note));
  if v_r is not null then
    return v_r;
  end if;
  begin
    if p_note is not null and pg_catalog.length(p_note) > 200 then
      raise exception 'Комментарий: не больше 200 символов' using errcode = '22023';
    end if;
    select * into v_t from private.panel_target(p_kn_id);
    v_uid := v_t.o_uid;
    -- порядок блокировок как у выдачи и подарка: пользователь (advisory) → строка ai_limits
    perform private.admin_lock(v_uid);
    select * into v_p from private.panel_gift_ai_plan(v_uid, p_ai_quota);
    if v_p.o_err is not null then
      v_r := jsonb_build_object('error', v_p.o_err);
    else
      perform 1 from private.ai_limits for update;
      v_b := private.panel_gift_ai_budget_check(v_p.o_kind, v_p.o_plan, p_ai_quota);
      if not (v_b ->> 'ok')::boolean then
        v_r := jsonb_build_object('error', 'BUDGET_LOW', 'need', v_b -> 'need', 'free', v_b -> 'free');
      else
        -- прибавляем к лимиту той же выдачи; срок, тариф и прочие поля не трогаем.
        -- Условие на прежний лимит и срок — защита от гонки (под admin_lock их никто не меняет, но проверяем)
        update private.access_grants g set ai_quota = g.ai_quota + p_ai_quota
         where g.id = v_p.o_grant and g.ai_quota = v_p.o_quota_before and g.revoked_at is null
           and (g.ends_at is null or g.ends_at > pg_catalog.now())
        returning g.id into v_id;
        if v_id is null then
          v_r := jsonb_build_object('error', 'STATE_CHANGED');
        else
          insert into private.access_log (action, user_id, grant_id, actor, details)
          values ('gift_ai', v_uid, v_id, 'panel:' || v_c.o_kn,
                  jsonb_build_object('ai_quota', p_ai_quota, 'grant_kind', v_p.o_kind, 'grant_plan', v_p.o_plan,
                                     'quota_before', v_p.o_quota_before, 'quota_after', v_p.o_quota_after,
                                     'ends_at', v_p.o_ends, 'note', nullif(pg_catalog.btrim(p_note), '')));
          v_r := jsonb_build_object('result', 'gifted_ai', 'kn_id', v_t.o_kn, 'ai_quota', p_ai_quota,
                   'grant_kind', v_p.o_kind, 'grant_plan', v_p.o_plan,
                   'quota_before', v_p.o_quota_before, 'quota_after', v_p.o_quota_after, 'ends_at', v_p.o_ends,
                   'access', private.access_state(v_uid));
        end if;
      end if;
    end if;
  exception when others then
    v_r := private.panel_error(sqlstate, sqlerrm);
  end;
  if v_r ? 'error' then
    perform private.panel_refused(v_uid, 'gift_ai', v_r);
  end if;
  return private.panel_request_done(p_request_id, v_r);
end
$$;

revoke all on function
  private.panel_gift_ai_plan(uuid, integer), private.panel_gift_ai_budget_check(text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function
  public.owner_gift_ai_preview(text, text, integer), public.owner_gift_ai(text, uuid, text, integer, text)
  from public, anon, authenticated, service_role;
-- как у остальных owner_*: вызывает вошедший пользователь, а права владельца проверяет сессия панели внутри функции
grant execute on function
  public.owner_gift_ai_preview(text, text, integer), public.owner_gift_ai(text, uuid, text, integer, text)
  to authenticated;
