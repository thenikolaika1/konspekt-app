-- ТОЛЬКО ЧТЕНИЕ. Число строк в таблицах с данными пользователей (вывод: таблица|число).
-- Отсутствующие таблицы пропускаются (query_to_xml — подсчёт без временных объектов и без записи).
select t as "table",
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %s', t), false, true, '')))[1]::text::bigint as "rows"
  from unnest(array[
    'auth.users', 'auth.identities', 'auth.sessions', 'auth.refresh_tokens',
    'public.notes', 'public.ai_generations', 'public.bookmarks', 'public.bookmark_notes',
    'private.user_entitlements', 'private.usage_ledger', 'private.beta_invites',
    'storage.buckets', 'storage.objects', 'supabase_migrations.schema_migrations'
  ]) as t
 where to_regclass(t) is not null
 order by 1;
