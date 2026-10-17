-- =====================================================================================
-- Konspekt v58: самостоятельная регистрация в Supabase Auth — только по приглашению.
--
-- Анонимные входы (гостевой режим) требуют включённой регистрации («Allow new users to sign up»), а она же открывает
-- стандартный POST /auth/v1/signup: кто угодно мог бы создать аккаунт с email и паролем. Такой аккаунт не получает
-- права на AI (права выдаёт только регистрация по приглашению), но аккаунты учеников должны создаваться только ею.
--
-- Хук Auth «Before User Created» вызывается при signup, анонимном входе, OAuth/SSO/Web3, приглашении по email —
-- и НЕ вызывается при создании пользователя через Admin API (так создаёт аккаунты Edge Function register-invite).
-- Функция ниже пропускает только анонимных пользователей; всё остальное — 403.
--
-- Включение (владелец): Dashboard → Authentication → Hooks → Before User Created → Postgres →
-- схема public, функция hook_before_user_created. Без включения хука функция ни на что не влияет.
-- Откат: выключить хук в Dashboard; затем (по желанию) drop function public.hook_before_user_created(jsonb).
-- =====================================================================================
create function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce((event -> 'user' ->> 'is_anonymous')::boolean, false) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'Регистрация — только по приглашению в приложении Konspekt'));
end
$$;

revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
