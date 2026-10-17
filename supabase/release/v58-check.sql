-- Konspekt v58: проверка после миграции 20261018120000 (только чтение). Все строки ok = true.
select 'функции регистрации есть' as check, count(*) = 2 as ok
  from pg_proc where oid in ('public.register_invite_begin(text,text,text)'::regprocedure, 'public.register_invite_finish(text,uuid,uuid)'::regprocedure)
union all
select 'регистрация — только service_role',
       has_function_privilege('service_role', 'public.register_invite_begin(text,text,text)', 'execute')
       and not has_function_privilege('authenticated', 'public.register_invite_begin(text,text,text)', 'execute')
       and not has_function_privilege('anon', 'public.register_invite_begin(text,text,text)', 'execute')
       and not has_function_privilege('authenticated', 'public.register_invite_finish(text,uuid,uuid)', 'execute')
       and not has_function_privilege('anon', 'public.register_invite_finish(text,uuid,uuid)', 'execute')
union all
select 'таблицы регистрации закрыты для API',
       not has_table_privilege('authenticated', 'private.invite_registrations', 'select')
       and not has_table_privilege('anon', 'private.register_attempts', 'select')
       and not has_table_privilege('service_role', 'private.invite_registrations', 'select')
union all
select 'redeem_beta_invite отключена', pg_get_functiondef('public.redeem_beta_invite(text)'::regprocedure) like '%registration_required%'
union all
select 'AI выключен (max_total_starts = 0)', (select max_total_starts = 0 from private.ai_limits)
union all
select 'manual-права не изменены (2 × quota 100)', (select count(*) = 2 from private.user_entitlements where source = 'manual' and quota = 100);
select * from private.invite_status();
