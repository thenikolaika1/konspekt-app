-- Снимок данных до и после v62 (ТОЛЬКО ЧТЕНИЕ). Печатает по таблице: имя | число строк | md5 всех строк — без самих данных.
-- Запуск: psql DB -X -A -t -f supabase/release/v62-snapshot.sql > snapshot-before.txt  (потом после миграции — snapshot-after.txt)
-- Снимки должны совпасть. Различие возможно, только если между снимками кто-то пользовался приложением (вход, конспект,
-- аналитика): тогда отличаются лишь эти таблицы — сделай снимки и миграцию подряд, в тихое время.
-- access_settings сравнивается без колонок, которые добавляет v62; private.plans не сравнивается (v62 добавляет тариф).
begin transaction read only;
select t || '|' || n || '|' || h from (
  select 'auth.users' t, count(*) n, md5(coalesce(string_agg(x::text, '|' order by x.id), '')) h from auth.users x union all
  select 'public.notes', count(*), md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from public.notes x union all
  select 'public.ai_generations', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.ai_generations x union all
  select 'private.access_grants', count(*), md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from private.access_grants x union all
  select 'private.user_entitlements', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.user_entitlements x union all
  select 'private.usage_ledger', count(*), md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from private.usage_ledger x union all
  select 'private.generation_starts', count(*), md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from private.generation_starts x union all
  select 'private.access_log', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.access_log x union all
  select 'private.beta_invites', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.beta_invites x union all
  select 'private.invite_registrations', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.invite_registrations x union all
  select 'private.ai_limits', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.ai_limits x union all
  select 'private.access_settings(v61)', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'budget_reserve_factor' - 'owner_reserve_starts' - 'budget_warn_percent')::text, '|'), '')) from private.access_settings x union all
  select 'private.owner_panel_secrets', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.owner_panel_secrets x union all
  select 'private.owner_panel_sessions', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.owner_panel_sessions x union all
  select 'private.owner_requests', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.owner_requests x union all
  select 'private.invite_meta', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from private.invite_meta x union all
  select 'analytics.app_events', count(*), md5(coalesce(string_agg(x::text, '|' order by x.id), '')) from analytics.app_events x union all
  select 'analytics.paragraph_views', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from analytics.paragraph_views x union all
  select 'analytics.catalog_paragraphs', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from analytics.catalog_paragraphs x
) s order by t;
commit;
