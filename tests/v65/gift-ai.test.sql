-- v65: подарок «Только ИИ-генерации» (owner_gift_ai). Только локальная копия базы (НЕ production).
-- Запускается в той же сессии psql сразу после tests/v62/v62.test.sql (его помощники t.*, владелец :uo/:so,
-- ученики и подарки): tests/v65/run.sh.
delete from t.results;
select t.as_user(:'uo', :'so');
select t.lim(1000, 0);
create function t.gai(p_kn text, p_q int, p_rq uuid default gen_random_uuid()) returns jsonb language sql as
  $$ select t.p(format('select public.owner_gift_ai($S, %L, %L, %s)', p_rq, p_kn, coalesce(p_q::text, 'null'))) $$;
create function t.gaip(p_kn text, p_q int) returns jsonb language sql as
  $$ select t.p(format('select public.owner_gift_ai_preview($S, %L, %s)', p_kn, coalesce(p_q::text, 'null'))) $$;
create function t.acc(p_uid uuid) returns jsonb language sql as $$ select private.access_state(p_uid) $$;
-- всё о выдачах ученика, кроме лимита: доступ, даты, тариф, отзыв
create function t.shape(p_uid uuid) returns text language sql as
  $$ select coalesce(string_agg(concat_ws('|', kind, plan, starts_at, ends_at, revoked_at), ';' order by created_at, id), '-')
       from private.access_grants where user_id = p_uid $$;
create function t.quotas(p_uid uuid) returns text language sql as
  $$ select coalesce(string_agg(kind || coalesce(':' || plan, '') || '=' || coalesce(ai_quota::text, '∞'), ',' order by created_at, id), '-')
       from private.access_grants where user_id = p_uid $$;
-- снимок всех выдач всех учеников (для проверки «остальные не тронуты»)
create table t.all_before as select id, user_id, kind, plan, starts_at, ends_at, ai_quota, revoked_at from private.access_grants;

-- ---------- A. пробный период: было 2 доступных, +5 → 7; срок не меняется ----------
select t.register('GAICODE00001', 'KN-QAAAAA') as ha \gset
update private.access_grants set ai_quota = 2 where user_id = :'ha' and kind = 'trial';
select t.shape(:'ha') as ha_shape \gset
select t.gaip('KN-QAAAAA', 5) as hp \gset
select t.ok('A0. предпросмотр: пробный период, было 2, станет 7, срок до конца пробного; ничего не начислено',
  :'hp'::jsonb ->> 'action' = 'gift_ai' and :'hp'::jsonb ->> 'grant_kind' = 'trial'
  and (:'hp'::jsonb ->> 'remaining_before')::int = 2 and (:'hp'::jsonb ->> 'remaining_after')::int = 7
  and (:'hp'::jsonb -> 'budget_check' ->> 'ok')::boolean and t.quotas(:'ha') = 'trial=2', :'hp');
select t.gai('KN-QAAAAA', 5) as h1 \gset
select t.ok('A1. +5 к пробному: gifted_ai, лимит 2 → 7, доступно 7, статус «пробный»',
  :'h1'::jsonb ->> 'result' = 'gifted_ai' and (:'h1'::jsonb ->> 'quota_before')::int = 2 and (:'h1'::jsonb ->> 'quota_after')::int = 7
  and t.quotas(:'ha') = 'trial=7' and (t.acc(:'ha') ->> 'ai_available')::int = 7 and t.acc(:'ha') ->> 'status' = 'trial', :'h1');
select t.ok('A1. срок не изменился: те же выдачи, даты, тариф; Premium не появился', t.shape(:'ha') = :'ha_shape'
  and not exists (select 1 from private.access_grants where user_id = :'ha' and kind = 'paid'), t.shape(:'ha'));

-- ---------- B. повторная выдача: +3, потом +4 ----------
select t.gai('KN-QAAAAA', 3) ->> 'result' as b1 \gset
select t.gai('KN-QAAAAA', 4) ->> 'result' as b2 \gset
select t.ok('B1. две выдачи подряд учтены обе: 7 + 3 + 4 = 14, срок тот же', :'b1' = 'gifted_ai' and :'b2' = 'gifted_ai'
  and t.quotas(:'ha') = 'trial=14' and t.shape(:'ha') = :'ha_shape', t.quotas(:'ha'));
select t.ok('B2. журнал: три записи gift_ai от панели (+5, +3, +4) с прежним и новым лимитом, без срока',
  (select string_agg((details ->> 'ai_quota') || ':' || (details ->> 'quota_before') || '→' || (details ->> 'quota_after'), ',' order by id)
     from private.access_log where action = 'gift_ai' and user_id = :'ha' and actor = 'panel:KN-WAAAAA') = '5:2→7,3:7→10,4:10→14'
  and not exists (select 1 from private.access_log where action = 'gift_ai' and user_id = :'ha' and details ? 'days'));

-- ---------- C. использованные генерации сохраняются; подаренные тратятся ----------
select t.register('GAICODE00002', 'KN-QBAAAA') as hb \gset
select t.gen(:'hb', true) as c1 \gset
select t.gen(:'hb', true) as c2 \gset
select t.ok('C0. пробный (1 генерация): первая started, вторая — отказ', :'c1' = 'started' and :'c2' <> 'started', :'c2');
select t.gai('KN-QBAAAA', 2) as c3 \gset
select t.ok('C1. +2 после использованной: лимит 3, использовано 1 (не сброшено), доступно 2',
  :'c3'::jsonb ->> 'result' = 'gifted_ai' and (t.acc(:'hb') ->> 'ai_used')::int = 1 and (t.acc(:'hb') ->> 'ai_available')::int = 2, t.acc(:'hb')::text);
select t.gen(:'hb', true) || ',' || t.gen(:'hb', true) || ',' || t.gen(:'hb', true) as c4 \gset
select t.ok('C2. подаренные генерации работают: две started, третья — отказ (лимит)', :'c4' ~ '^started,started,(?!started)', :'c4');

-- ---------- D. подарок «дни + генерации» и потом «только генерации» ----------
select t.register('GAICODE00003', 'KN-QCAAAA') as hc \gset
update private.access_grants set starts_at = starts_at - interval '8 days', ends_at = ends_at - interval '8 days' where user_id = :'hc';
select t.gift('KN-QCAAAA', 7, 1) ->> 'result' as d0 \gset
select t.shape(:'hc') as hc_shape \gset
select t.gai('KN-QCAAAA', 1) as d1 \gset
select t.ok('D1. подарок 7 дней + 1, потом +1 генерация: в подарке 2 генерации, срок подарка тот же (пример владельца)',
  :'d0' = 'gifted' and :'d1'::jsonb ->> 'result' = 'gifted_ai' and :'d1'::jsonb ->> 'grant_plan' = 'gift'
  and t.quotas(:'hc') = 'trial=1,paid:gift=2' and t.shape(:'hc') = :'hc_shape' and t.acc(:'hc') ->> 'plan_title' = 'Подарок', :'d1');
select t.gift('KN-QCAAAA', 3, 1) as d2 \gset
select t.ok('D2. прежний подарок «дни + генерации» работает как раньше: добавлен к подарку (+3 дня, 2 + 1 = 3)',
  :'d2'::jsonb ->> 'result' = 'gifted' and (:'d2'::jsonb ->> 'merged')::boolean and t.gifts(:'hc') = '10 days/3', :'d2');

-- ---------- E. Premium: генерации к текущему сроку, срок и будущие сроки не меняются ----------
select t.register('GAICODE00004', 'KN-QDAAAA') as hd \gset
select :'hd' as qd \gset
select private.admin_grant('KN-QDAAAA', 'premium') ->> 'result' as e0 \gset
select t.gift('KN-QDAAAA', 5, 2) ->> 'result' as e0b \gset
select t.shape(:'hd') as hd_shape \gset
select private.premium_obligations() as eob \gset
select t.gai('KN-QDAAAA', 5) as e1 \gset
select t.ok('E1. Premium 10 + 5 → 15 у текущего Premium; будущий подарок (2) не тронут; даты и тариф те же',
  :'e1'::jsonb ->> 'result' = 'gifted_ai' and :'e1'::jsonb ->> 'grant_plan' = 'premium'
  and t.quotas(:'hd') = 'trial=1,paid:premium=15,paid:gift=2' and t.shape(:'hd') = :'hd_shape'
  and t.acc(:'hd') ->> 'plan_title' = 'Premium' and (t.acc(:'hd') ->> 'ai_available')::int = 15, t.quotas(:'hd'));
select t.ok('E2. генерации Premium входят в резерв: обязательства +5', private.premium_obligations() = :eob + 5, private.premium_obligations()::text);

-- ---------- F. повтор запроса ----------
select gen_random_uuid() as frq \gset
select t.gai('KN-QAAAAA', 2, :'frq') as f1 \gset
select t.gai('KN-QAAAAA', 2, :'frq') as f2 \gset
select t.ok('F1. тот же запрос дважды (двойное нажатие, обрыв сети): второй — replayed, начислено один раз (14 + 2 = 16)',
  :'f1'::jsonb ->> 'result' = 'gifted_ai' and (:'f2'::jsonb ->> 'replayed')::boolean and t.quotas(:'ha') = 'trial=16'
  and (select count(*) from private.access_log where action = 'gift_ai' and user_id = :'ha') = 4, t.quotas(:'ha'));
select t.ok('F2. тот же request_id с другим числом → REQUEST_REUSED, ничего не начислено',
  t.gai('KN-QAAAAA', 9, :'frq') ->> 'error' = 'REQUEST_REUSED' and t.quotas(:'ha') = 'trial=16');

-- ---------- G. права ----------
select t.as_user(:'hb', t.login(:'hb'));
select t.ok('G1. ученик себе: FORBIDDEN, лимит не изменился', t.gai('KN-QBAAAA', 50) ->> 'error' = 'FORBIDDEN'
  and t.gaip('KN-QBAAAA', 5) ->> 'error' = 'FORBIDDEN' and t.quotas(:'hb') = 'trial=3');
select t.ok('G2. ученик другому: FORBIDDEN', t.gai('KN-QAAAAA', 50) ->> 'error' = 'FORBIDDEN' and t.quotas(:'ha') = 'trial=16');
select t.ok('G3. ученик напрямую вызывает внутренние функции: нет прав',
  t.api(format('select to_jsonb(private.panel_gift_ai_plan(%L, 5))', :'hb')) ->> 'sqlerror' = '42501');
select t.as_user(:'ug', null, true);
select t.ok('G4. гость: FORBIDDEN', t.api('select public.owner_gift_ai(''x'', gen_random_uuid(), ''KN-QAAAAA'', 5)') ->> 'error' = 'FORBIDDEN');
select t.ok('G5. права функций: owner_gift_ai — только authenticated (дальше — сессия панели), anon — нет; внутренние — никому',
  has_function_privilege('authenticated', 'public.owner_gift_ai(text,uuid,text,integer,text)', 'execute')
  and has_function_privilege('authenticated', 'public.owner_gift_ai_preview(text,text,integer)', 'execute')
  and not has_function_privilege('anon', 'public.owner_gift_ai(text,uuid,text,integer,text)', 'execute')
  and not has_function_privilege('authenticated', 'private.panel_gift_ai_plan(uuid,integer)', 'execute')
  and not has_function_privilege('service_role', 'private.panel_gift_ai_budget_check(text,text,integer)', 'execute'));
select t.as_user(:'uo', :'so');
update t.ctx set method = 'GET';
select t.ok('G6. GET → METHOD_NOT_ALLOWED', t.gai('KN-QAAAAA', 1) ->> 'error' = 'METHOD_NOT_ALLOWED' and t.quotas(:'ha') = 'trial=16');
update t.ctx set method = 'POST';
select t.ok('G7. неверная сессия панели → отказ', t.api('select public.owner_gift_ai(''0000'', gen_random_uuid(), ''KN-QAAAAA'', 1)') ->> 'error' is not null
  and t.quotas(:'ha') = 'trial=16');

-- ---------- H. неверные данные ----------
select t.ok('H1. 0, отрицательное, пусто (NULL), больше 100 за раз → GIFT_AI_INVALID (и в предпросмотре)',
  t.gai('KN-QAAAAA', 0) ->> 'error' = 'GIFT_AI_INVALID' and t.gai('KN-QAAAAA', -3) ->> 'error' = 'GIFT_AI_INVALID'
  and t.gai('KN-QAAAAA', null) ->> 'error' = 'GIFT_AI_INVALID' and t.gai('KN-QAAAAA', 101) ->> 'error' = 'GIFT_AI_INVALID'
  and t.gaip('KN-QAAAAA', 0) ->> 'error' = 'GIFT_AI_INVALID' and t.quotas(:'ha') = 'trial=16');
select t.ok('H2. дробное число не принимается сервером (тип integer): ошибка, ничего не начислено',
  t.p('select public.owner_gift_ai($S, gen_random_uuid(), ''KN-QAAAAA'', 1.5)') ? 'sqlerror'
  and t.p('select public.owner_gift_ai($S, gen_random_uuid(), ''KN-QAAAAA'', ''abc'')') ? 'sqlerror' and t.quotas(:'ha') = 'trial=16');
update private.access_grants set ai_quota = 950 where user_id = :'ha' and kind = 'trial';
select t.ok('H3. итог больше 1000 (950 + 100) → GIFT_TOO_LARGE, лимит не изменился', t.gai('KN-QAAAAA', 100) ->> 'error' = 'GIFT_TOO_LARGE'
  and t.quotas(:'ha') = 'trial=950');
update private.access_grants set ai_quota = 16 where user_id = :'ha' and kind = 'trial';
select t.ok('H4. несуществующий ID → USER_NOT_FOUND, неверный формат → INVALID_ID',
  t.gai('KN-ZZZZZZ', 1) ->> 'error' = 'USER_NOT_FOUND' and t.gai('abc', 1) ->> 'error' = 'INVALID_ID'
  and t.gaip('KN-ZZZZZZ', 1) ->> 'error' = 'USER_NOT_FOUND');
select t.ok('H5. комментарий длиннее 200 → INVALID_INPUT',
  t.p(format('select public.owner_gift_ai($S, gen_random_uuid(), ''KN-QAAAAA'', 1, %L)', repeat('я', 201))) ->> 'error' = 'INVALID_INPUT'
  and t.quotas(:'ha') = 'trial=16');

-- ---------- I. без действующего доступа — нельзя ----------
select t.register('GAICODE00005', 'KN-QEAAAA') as he \gset
update private.access_grants set starts_at = starts_at - interval '8 days', ends_at = ends_at - interval '8 days' where user_id = :'he';
select t.shape(:'he') || '#' || t.quotas(:'he') as he_before \gset
select t.ok('I1. пробный закончился: NO_ACTIVE_ACCESS (предпросмотр и выдача), ничего не изменилось, ИИ закрыт',
  t.gaip('KN-QEAAAA', 3) ->> 'error' = 'NO_ACTIVE_ACCESS' and t.gai('KN-QEAAAA', 3) ->> 'error' = 'NO_ACTIVE_ACCESS'
  and t.shape(:'he') || '#' || t.quotas(:'he') = :'he_before' and t.acc(:'he') ->> 'status' = 'expired' and t.gen(:'he') <> 'started');
select t.p('select public.owner_revoke($S, gen_random_uuid(), ''KN-QDAAAA'', ''тест'', 2)') ->> 'result' as i2r \gset
select t.gai('KN-QDAAAA', 1) as i2 \gset
select t.ok('I2. после отзыва подписки и подарка идёт пробный: генерация добавлена к пробному, отозванные сроки не тронуты',
  :'i2r' = 'revoked' and :'i2'::jsonb ->> 'grant_kind' = 'trial'
  and (select string_agg(kind || coalesce(':' || plan, '') || '=' || ai_quota || case when revoked_at is not null then 'R' else '' end, ',' order by created_at)
         from private.access_grants where user_id = :'qd') = 'trial=2,paid:premium=15R,paid:gift=2R', :'i2');
select t.age(:'qd', interval '8 days');
select t.ok('I2. когда закончился и пробный — NO_ACTIVE_ACCESS', t.gai('KN-QDAAAA', 1) ->> 'error' = 'NO_ACTIVE_ACCESS');
select t.ok('I3. владелец → GIFT_OWNER; старый ручной доступ → GIFT_MANUAL_ACCESS; выдачи не созданы',
  t.gai('KN-WAAAAA', 1) ->> 'error' = 'GIFT_OWNER' and t.gai('KN-GMAAAA', 1) ->> 'error' = 'GIFT_MANUAL_ACCESS'
  and not exists (select 1 from private.access_grants where user_id = :'gum'));
select t.ok('I4. отказы записаны в журнал (panel_refused, op gift_ai)',
  (select count(*) from private.access_log where action = 'panel_refused' and details ->> 'op' = 'gift_ai') >= 10);

-- ---------- J. подаренные генерации сгорают вместе с доступом ----------
select t.age(:'ha', interval '7 days 1 minute');
select t.ok('J1. пробный с подаренными генерациями закончился: доступ «истёк», доступно 0, ИИ закрыт',
  t.acc(:'ha') ->> 'status' = 'expired' and (t.acc(:'ha') ->> 'ai_available')::int = 0 and t.gen(:'ha') <> 'started', t.acc(:'ha')::text);

-- ---------- K. бюджет ----------
select t.register('GAICODE00006', 'KN-QFAAAA') as hf \gset
select t.lim(500, 500 - (t.bi('premium_reserve') + t.bi('owner_reserve_left') + ceil(t.bi('gift_obligations') * 1.5)::int + 2));
select t.ok('K1. мало бюджета (свободно 2, на 2 генерации нужно 3): предпросмотр предупреждает, выдача → BUDGET_LOW, лимит тот же',
  not (t.gaip('KN-QFAAAA', 2) -> 'budget_check' ->> 'ok')::boolean and t.gai('KN-QFAAAA', 2) ->> 'error' = 'BUDGET_LOW'
  and t.quotas(:'hf') = 'trial=1');
select t.ok('K2. на 1 генерацию хватает → начислено', t.gai('KN-QFAAAA', 1) ->> 'result' = 'gifted_ai' and t.quotas(:'hf') = 'trial=2');
select t.lim(1000, 0);

-- ---------- L. история и прочие ученики ----------
select t.p('select public.owner_student($S, ''KN-QCAAAA'')') as l1 \gset
select t.ok('L1. карточка ученика: в истории «gift_ai» с числом генераций',
  exists (select 1 from jsonb_array_elements(:'l1'::jsonb -> 'history') h where h ->> 'action' = 'gift_ai' and (h -> 'details' ->> 'ai_quota')::int = 1), left(:'l1', 300));
select t.p('select public.owner_history($S, 50, 0)') as l2 \gset
select t.ok('L2. общая лента панели: событие gift_ai с ID ученика и «из панели»',
  exists (select 1 from jsonb_array_elements(:'l2'::jsonb -> 'items') h where h ->> 'type' = 'gift_ai' and h ->> 'by' = 'panel' and h ->> 'kn_id' like 'KN-Q%'), left(:'l2', 300));
select t.ok('L3. выдачи остальных учеников (до этих тестов) не изменились: ни лимит, ни сроки',
  (select count(*) from private.access_grants g join t.all_before b using (id)
    where (g.user_id, g.kind, g.plan, g.starts_at, g.ends_at, g.ai_quota, g.revoked_at)
          is not distinct from (b.user_id, b.kind, b.plan, b.starts_at, b.ends_at, b.ai_quota, b.revoked_at)) = (select count(*) from t.all_before));

select (case when ok then 'PASS ' else 'FAIL ' end) || name || case when not ok and info is not null then ' → ' || left(info, 600) else '' end from t.results order by n;
select 'ИТОГО: ' || count(*) filter (where ok) || ' PASS, ' || count(*) filter (where not ok) || ' FAIL' from t.results;
