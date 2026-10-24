-- Минимальная имитация окружения Supabase для локальной проверки миграций (НЕ production).
-- Роли API, схема auth (users, uid()), storage (buckets, objects, foldername), таблицы public как в production.
-- роли общие для всего кластера: при повторном запуске уже существуют
do $$
declare r text[];
begin
  foreach r slice 1 in array array[['anon', 'nologin'], ['authenticated', 'nologin'], ['service_role', 'nologin bypassrls'],
                                   ['authenticator', 'noinherit login'], ['supabase_auth_admin', 'nologin']] loop
    if not exists (select 1 from pg_roles where rolname = r[1]) then
      execute format('create role %I %s', r[1], r[2]);
    end if;
  end loop;
end $$;
grant anon, authenticated, service_role to authenticator;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email varchar unique,
  encrypted_password varchar,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  deleted_at timestamptz,
  is_anonymous boolean not null default false
);
-- как в Supabase: uid() — из claims запроса
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         current_setting('request.jwt.claims', true)::jsonb ->> 'sub'), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, created_at timestamptz default now());
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'processing' check (status = any (array['processing','ready','failed'])),
  stage text, error_code text, title text, subject text, preview text, content jsonb,
  schema_version integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid references public.notes(id) on delete set null,
  model text not null, page_count integer not null default 0 check (page_count >= 0),
  input_tokens integer, output_tokens integer, estimated_cost numeric, latency integer,
  status text not null check (status = any (array['processing','success','failed'])),
  created_at timestamptz not null default now()
);
create table public.bookmarks (id uuid primary key default gen_random_uuid(), user_id uuid not null, name text not null, icon text, color text, created_at timestamptz not null default now());
create table public.bookmark_notes (bookmark_id uuid not null, note_id uuid not null, user_id uuid not null);
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
