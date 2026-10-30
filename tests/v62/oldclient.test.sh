#!/bin/bash
# v62: совместимость интерфейса v61.3 (коммит 53d3203 — то, что сейчас у учеников и в кэше PWA) с базой v62.
# Между миграцией и публикацией сайта (и пока PWA не обновилась) старый клиент обращается к новой базе:
# каждая функция, которую он вызывает (supabase.rpc / панель владельца / Edge Function), должна в v62 существовать,
# принимать те же именованные аргументы (новые — только со значением по умолчанию) и быть доступной той же роли.
# Список вызовов берётся из кода 53d3203, а не вручную. Только локально (НЕ production). Нужна база base62 из run.sh.
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X -tA"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1 → '$2' ожидалось '$3'"; fi; }
OLD=53d3203
if ! git -C "$ROOT" cat-file -e "$OLD^{commit}" 2>/dev/null; then echo "SKIP oldclient: в клоне нет коммита $OLD"; exit 0; fi

# вызовы клиента v61.3: имя функции и имена аргументов (панель добавляет p_session ко всем вызовам call(), кроме входа)
CALLS=$(for f in app.js js/cloud.js js/owner.js js/store.js js/analytics.js js/library.js; do git -C "$ROOT" show "$OLD:$f" 2>/dev/null; done | node -e '
const s = require("fs").readFileSync(0, "utf8");
const out = new Map();
const add = (fn, args, role) => out.set(fn + "|" + [...new Set(args)].sort().join(",") + "|" + role, 1);
for (const m of s.matchAll(/\b(callRpc|ownerRpc|call)\(\s*"([a-z_0-9]+)"\s*(?:,\s*(\{[\s\S]*?\}))?/g)) {
  const args = m[3] ? [...m[3].matchAll(/\b(p_[a-z_0-9]+)\s*:/g)].map((x) => x[1]) : [];
  if (m[1] === "call") args.push("p_session");            // owner.js: call() = ownerRpc(fn, { p_session, ...args })
  add(m[2], args, "authenticated");
}
// панель: выдача и продление — имя функции выбирается в коде (owner_grant / owner_extend)
const g = s.match(/const args = \{ (p_request_id[^}]*)\};\s*if \(r\.action === "extend"\) args\.(p_[a-z_]+)/);
if (!g) throw new Error("не найден вызов owner_grant/owner_extend");
const ga = [...g[1].matchAll(/\b(p_[a-z_0-9]+)\s*:/g)].map((x) => x[1]).concat("p_session");
add("owner_grant", ga, "authenticated"); add("owner_extend", ga.concat(g[2]), "authenticated");
console.log([...out.keys()].sort().join("\n"));')
EDGE=$(git -C "$ROOT" show "$OLD:supabase/functions/analyze-pages/index.ts" | node -e '
const s = require("fs").readFileSync(0, "utf8");
for (const m of s.matchAll(/\.rpc\(\s*"([a-z_0-9]+)"\s*,\s*\{([\s\S]*?)\}/g))
  console.log(m[1] + "|" + [...m[2].matchAll(/\b(p_[a-z_0-9]+)\s*:/g)].map((x) => x[1]).sort().join(",") + "|service_role");')
ALL=$(printf '%s\n%s\n' "$CALLS" "$EDGE" | grep -v '^$' | sort -u)
check "1. вызовы v61.3 найдены в коде: клиент, панель, Edge Function (не меньше 20 разных)" "$([ "$(echo "$ALL" | wc -l)" -ge 20 ] && echo ok)" "ok"
check "1. Edge Function v62 = v61.3 (код analyze-pages не менялся)" "$(git -C "$ROOT" diff --quiet "$OLD" HEAD -- supabase/functions/analyze-pages/index.ts && echo same)" "same"

$P -d postgres -c "drop database if exists old62" -c "create database old62 template base62" >/dev/null
BAD=$(echo "$ALL" | while IFS='|' read -r fn args role; do
  r=$($P -d old62 -c "
    with f as (
      select p.oid, p.pronargs, p.pronargdefaults, coalesce(p.proargnames[1:p.pronargs], '{}') names
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '$fn'),
    want as (select coalesce(nullif('$args', ''), null) a)
    select count(*) from f, want
     where (want.a is null or string_to_array(want.a, ',') <@ f.names)
       -- аргументы, которых клиент не передаёт, должны иметь значение по умолчанию (они — последние pronargdefaults)
       and f.pronargs - f.pronargdefaults <= (select count(*) from unnest(f.names[1:f.pronargs - f.pronargdefaults]) x
                                               where x = any(coalesce(string_to_array(want.a, ','), '{}')))
       and has_function_privilege('$role', f.oid, 'execute')")
  [ "$r" = "1" ] || echo "$fn($args) для $role: подходящих функций $r"
done)
[ -n "$BAD" ] && echo "$BAD"
check "2. каждую функцию v61.3 можно вызвать в v62 с теми же аргументами и той же ролью ($(echo "$ALL" | wc -l | tr -d ' ') вызовов)" "$(echo -n "$BAD" | grep -c .)" "0"

# поведение: старая панель выдаёт подписку без p_custom — стандартные условия Premium проходят, нестандартные
# отклоняются понятной ошибкой (без изменения данных), а не падением
$P -d old62 -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
create function public.t_reg(p_code text, p_kn text) returns uuid language plpgsql as $$
declare r jsonb; v uuid;
begin
  insert into private.beta_invites (code_hash, quota, expires_at) values (private.invite_code_hash(p_code), 1, now() + interval '7 days');
  r := public.register_invite_begin(p_code, p_kn, repeat('a', 64));
  insert into auth.users (email, raw_app_meta_data) values (private.kn_email(p_kn), jsonb_build_object('kn_reservation', r ->> 'reservation')) returning id into v;
  perform public.register_invite_finish(p_code, (r ->> 'reservation')::uuid, v);
  return v;
end $$;
select public.t_reg('OLDOWNER0001', 'KN-WAAAAA'), public.t_reg('OLDSTUD00001', 'KN-SAAAAA');
select private.admin_set_owner('KN-WAAAAA');
update private.ai_limits set max_total_starts = 1000, total_starts = 0 where id;
SQL
# вход владельца и пароль панели — как в браузере: роль authenticated, JWT с sub и session_id, POST
OUT3=$($P -d old62 2>&1 <<'SQL'
create function pg_temp.api(p_uid uuid, p_sid uuid, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_uid, 'session_id', p_sid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('request.method', 'POST', true);
  set local role authenticated;
  execute p_sql into r;
  reset role;
  return r;
exception when others then
  reset role;
  return jsonb_build_object('sqlerror', sqlstate, 'message', sqlerrm);
end $$;
select id as uo from auth.users where email = private.kn_email('KN-WAAAAA') \gset
insert into auth.sessions (user_id) values (:'uo') returning id as so \gset
select private.admin_panel_setup('KN-WAAAAA') ->> 'setup_code' as code \gset
select pg_temp.api(:'uo', :'so', format('select public.owner_panel_setup(%L, %L)', :'code', 'HJKMN-PQRST-23456-WXYZA')) ->> 'session' as tok \gset
select count(*) as g0 from private.access_grants where kind = 'paid' \gset
-- 1) вызов старой панели (без p_custom) на условиях Premium
select 'R1=' || coalesce(r ->> 'result', r::text) from (select pg_temp.api(:'uo', :'so', format(
  'select public.owner_grant(p_session => %L, p_request_id => gen_random_uuid(), p_kn_id => %L, p_days => 30, p_ai_quota => 10, p_note => null)', :'tok', 'KN-SAAAAA')) r) x;
-- 2) нестандартные условия без подтверждения
select 'R2=' || coalesce(r ->> 'error', r ->> 'result', r::text) from (select pg_temp.api(:'uo', :'so', format(
  'select public.owner_grant(p_session => %L, p_request_id => gen_random_uuid(), p_kn_id => %L, p_days => 45, p_ai_quota => 20, p_note => null)', :'tok', 'KN-SAAAAA')) r) x;
-- 3) продление старой панелью, как в 53d3203: предпросмотр → p_expect_starts_at = starts_at, если продление встаёт после текущего срока
select r ->> 'starts_at' as pst, (r ->> 'starts_after_current')::boolean as pafter from (select pg_temp.api(:'uo', :'so', format(
  'select public.owner_preview(p_session => %L, p_kn_id => %L, p_action => %L, p_days => 30, p_ai_quota => 10)', :'tok', 'KN-SAAAAA', 'extend')) r) x \gset
select 'R3=' || coalesce(r ->> 'result', r::text) from (select pg_temp.api(:'uo', :'so', format(
  'select public.owner_extend(p_session => %L, p_request_id => gen_random_uuid(), p_kn_id => %L, p_days => 30, p_ai_quota => 10, p_note => null, p_expect_starts_at => %L)',
  :'tok', 'KN-SAAAAA', case when :'pafter' then :'pst' end)) r) x;
select 'G=' || (count(*) - :g0) from private.access_grants where kind = 'paid';
select 'P=' || coalesce(pg_temp.api(:'uo', :'so', 'select public.get_plans()') ? 'sqlerror', true)::text
       || '/' || (pg_temp.api(:'uo', :'so', 'select public.get_my_access_v2()') ? 'status')::text;
SQL
)
val() { echo "$OUT3" | grep "^$1=" | head -1 | cut -d= -f2-; }
check "3. старая панель: owner_grant без p_custom на условиях Premium (30 дней, 10) — выдано" "$(val R1)" "granted"
check "3. старая панель: нестандартные условия без подтверждения — отказ с кодом, а не ошибка SQL" "$(val R2 | grep -cE '^[A-Z_]+$')" "1"
check "3. старая панель: owner_extend с p_expect_starts_at — продлено" "$(val R3)" "extended"
check "3. выдач paid прибавилось ровно 2 (выдача и продление; отказ ничего не создал)" "$(val G)" "2"
check "3. старый клиент: get_plans и get_my_access_v2 отвечают без ошибки" "$(val P)" "false/true"
[ "$(val R1)" = "granted" ] || echo "$OUT3" | grep -iE "error|R[123]=" | head -5
$P -d postgres -c "drop database old62" >/dev/null

echo "ИТОГО: $pass PASS, $fail FAIL"
[ $fail = 0 ]
