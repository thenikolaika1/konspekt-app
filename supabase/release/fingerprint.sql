-- ТОЛЬКО ЧТЕНИЕ. Описание структуры существующих таблиц приложения, построчно (вывод: категория|описание).
-- Только структура и права — данных пользователей здесь нет. Сравнение ДО/ПОСЛЕ показывает, что именно изменилось.
-- Миграции F&F не должны менять ни одну строку этого отпечатка. Функции сюда не входят:
-- их миграции меняют намеренно (проверяет postcheck.sql).
with t(s, n) as (values ('public','notes'), ('public','ai_generations'), ('public','bookmarks'), ('public','bookmark_notes'),
                        ('private','user_entitlements'), ('private','usage_ledger'), ('private','beta_invites')),
rel as (select c.oid, n.nspname s, c.relname n, c.relacl, c.relrowsecurity, c.relforcerowsecurity
          from pg_class c join pg_namespace n on n.oid = c.relnamespace join t on t.s = n.nspname and t.n = c.relname),
o as (
  select 'column' as k, r.s||'.'||r.n||'.'||a.attname||':'||format_type(a.atttypid, a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin, d.adrelid),'') as x
    from rel r join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = r.oid and d.adnum = a.attnum
  union all select 'column_acl', r.s||'.'||r.n||'.'||a.attname||':'||a.attacl::text
    from rel r join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped and a.attacl is not null
  union all select 'table_acl', r.s||'.'||r.n||':'||coalesce(r.relacl::text,'')  from rel r
  union all select 'rls', r.s||'.'||r.n||':'||r.relrowsecurity||':'||r.relforcerowsecurity from rel r
  union all select 'constraint', r.s||'.'||r.n||':'||k.conname||':'||pg_get_constraintdef(k.oid) from rel r join pg_constraint k on k.conrelid = r.oid
  union all select 'index', i.schemaname||'.'||i.indexname||':'||i.indexdef from pg_indexes i join t on t.s = i.schemaname and t.n = i.tablename
  union all select 'policy', p.schemaname||'.'||p.tablename||':'||p.policyname||':'||p.permissive||':'||p.cmd||':'||p.roles::text||':'||coalesce(p.qual,'')||':'||coalesce(p.with_check,'')
    from pg_policies p where (p.schemaname, p.tablename) in (select s, n from t) or p.schemaname = 'storage'
  union all select 'trigger', r.s||'.'||r.n||':'||pg_get_triggerdef(g.oid) from rel r join pg_trigger g on g.tgrelid = r.oid and not g.tgisinternal
  union all select 'bucket', id||':'||public||':'||coalesce(file_size_limit::text,'')||':'||coalesce(allowed_mime_types::text,'') from storage.buckets
)
select k, x from o order by k, x;
