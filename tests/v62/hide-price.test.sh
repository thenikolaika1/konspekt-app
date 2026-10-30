#!/bin/bash
# v62: шаг выпуска «скрыть цену Premium от учеников» (supabase/release/v62-hide-price.sql) и его отмена
# (v62-hide-price-undo.sql) на копии с v62. Только локально (НЕ production). Нужна база base62 из run.sh.
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
P="psql -h ${PGHOST:-/var/lib/postgresql/pg61} -p ${PGPORT:-54361} -U postgres -q -X -tA"
R="$ROOT/supabase/release"; M="$ROOT/supabase/migrations"; DB=hp62
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1 → '$2' ожидалось '$3'"; fi; }
run() { $P -d $DB -v ON_ERROR_STOP=1 -f "$1" >/dev/null 2>"$OUT/err"; echo $?; }
OUT=$(mktemp -d); trap 'rm -rf "$OUT"' EXIT
PLAN="select code || '|' || days || '|' || ai_quota || '|' || coalesce(price_label, 'NULL') || '|' || active from private.plans where code = 'premium'"
# как ученик: роль authenticated, JWT
AS_STUDENT="select set_config('request.jwt.claims', '{\"sub\":\"00000000-0000-0000-0000-000000000001\",\"role\":\"authenticated\"}', false)"

$P -d postgres -c "drop database if exists $DB" -c "create database $DB template base61" >/dev/null
$P -d $DB -v ON_ERROR_STOP=1 -f "$M/20261024150000_paid_access.sql" >/dev/null
$P -d $DB -v ON_ERROR_STOP=1 -f "$M/20261026120000_owner_panel.sql" >/dev/null
check "1. на v61.3 (без v62) шаг отклоняется, ничего не меняется" "$(run "$R/v62-hide-price.sql")/$(grep -c 'v62 не применена' "$OUT/err")/$($P -d $DB -c "select count(*) from private.plans")" "3/1/0"
$P -d $DB -v ON_ERROR_STOP=1 -f "$M/20261028120000_v62_paid_library.sql" >/dev/null
$P -d $DB -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create function public.t_reg(p_code text, p_kn text) returns uuid language plpgsql as $$
declare r jsonb; v uuid;
begin
  insert into private.beta_invites (code_hash, quota, expires_at) values (private.invite_code_hash(p_code), 1, now() + interval '7 days');
  r := public.register_invite_begin(p_code, p_kn, repeat('a', 64));
  insert into auth.users (email, raw_app_meta_data) values (private.kn_email(p_kn), jsonb_build_object('kn_reservation', r ->> 'reservation')) returning id into v;
  perform public.register_invite_finish(p_code, (r ->> 'reservation')::uuid, v);
  return v;
end $$;
select public.t_reg('HPSTUD000001', 'KN-SAAAAA'), public.t_reg('HPSTUD000002', 'KN-SBAAAA');
update private.ai_limits set max_total_starts = 1000, total_starts = 0 where id;
SQL
check "2. до шага: Premium 30/10/299 ₽, get_plans отдаёт цену" "$($P -d $DB -c "$PLAN")/$($P -d $DB -c "select public.get_plans() -> 0 ->> 'price_label'")" "premium|30|10|299 ₽|true/299 ₽"
check "3. отмена без скрытия — отказ, ничего не меняется" "$(run "$R/v62-hide-price-undo.sql")/$($P -d $DB -c "$PLAN")" "3/premium|30|10|299 ₽|true"

check "4. шаг применился (код 0, сообщение о проверке)" "$($P -d $DB -v ON_ERROR_STOP=1 -f "$R/v62-hide-price.sql" 2>&1 >/dev/null | grep -c 'цена Premium скрыта'; echo "${PIPESTATUS[0]}")" "1
0"
check "4. тариф: 30 дней, 10 генераций, активен, цены нет" "$($P -d $DB -c "$PLAN")" "premium|30|10|NULL|true"
check "4. get_plans для ученика (authenticated): Premium 30/10, поле price_label пустое" \
  "$($P -d $DB -c "$AS_STUDENT" -c "set role authenticated" -c "select (e ->> 'code') || '|' || (e ->> 'days') || '|' || (e ->> 'ai_quota') || '|' || coalesce(e ->> 'price_label', 'NULL') from jsonb_array_elements(public.get_plans()) e" | tail -1)" "premium|30|10|NULL"
check "4. в ответе get_plans нет «299» и «₽»" "$($P -d $DB -c "select public.get_plans()::text ~ '299|₽'")" "f"
check "5. панель не зависит от цены: выдача Premium на стандартных условиях работает" \
  "$($P -d $DB -c "select private.admin_grant('KN-SAAAAA', 'premium') ->> 'result'")/$($P -d $DB -c "select extract(day from g.ends_at - g.starts_at)::int || '/' || g.ai_quota || '/' || g.plan from private.access_grants g join auth.users u on u.id = g.user_id where u.email = private.kn_email('KN-SAAAAA') and g.kind = 'paid'")" "granted/30/10/premium"
check "5. бюджет и резерв считаются как раньше" "$($P -d $DB -c "select (b ->> 'obligations') || '/' || (b ->> 'premium_reserve') from private.budget_state() b")" "10/15"
check "6. повторный шаг — отказ «уже скрыта», ничего не меняется" "$(run "$R/v62-hide-price.sql")/$(grep -c 'уже скрыта' "$OUT/err")/$($P -d $DB -c "$PLAN")" "3/1/premium|30|10|NULL|true"

# откат v62 и повторное применение: при скрытой цене миграция останавливается (ничего не меняя), после отмены — проходит
check "7. откат v62 при скрытой цене — проходит" "$(run "$R/rollback-v62.sql")" "0"
check "7. повторная миграция при скрытой цене — остановлена проверкой тарифа, v62 не применена" \
  "$(run "$M/20261028120000_v62_paid_library.sql")/$(grep -c 'другими условиями' "$OUT/err")/$($P -d $DB -c "select to_regclass('private.library_paragraphs') is null")" "3/1/t"
check "7. отмена скрытия после отката — проходит" "$(run "$R/v62-hide-price-undo.sql")/$($P -d $DB -c "$PLAN")" "0/premium|30|10|299 ₽|false"
check "7. после отмены миграция снова применяется: Premium 30/10/299 ₽ активен" "$(run "$M/20261028120000_v62_paid_library.sql")/$($P -d $DB -c "$PLAN")" "0/premium|30|10|299 ₽|true"
check "8. и цену снова можно скрыть" "$(run "$R/v62-hide-price.sql")/$($P -d $DB -c "$PLAN")" "0/premium|30|10|NULL|true"
check "9. файлы шага — с LF, без CR" "$(cat "$R/v62-hide-price.sql" "$R/v62-hide-price-undo.sql" | grep -c $'\r')" "0"
$P -d postgres -c "drop database $DB" >/dev/null

echo "ИТОГО: $pass PASS, $fail FAIL"
[ $fail = 0 ]
