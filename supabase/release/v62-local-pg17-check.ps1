<#
  Konspekt by NK — генеральная репетиция v62 на СВОЁМ компьютере (НЕ production).

  Берёт резервную копию production (konspekt-full.dump из backup-before-v62.ps1), восстанавливает её в ПУСТУЮ локальную
  базу PostgreSQL 17 и проходит весь выпуск как в инструкции v62-paid-library.md:
    1. восстановление копии и проверка, что структура приложения = production (отпечаток 138 объектов);
    2. снимок данных до миграции;
    3. миграция v62 (как в production — один файл, одна транзакция);
    4. снимок после — данные учеников не изменились;
    5. загрузка 77 параграфов (закрытый library-seed.sql, контрольная сумма каждого параграфа);
    6. проверка доступа: владелец / пробный → текст; без доступа → ACCESS_REQUIRED;
    7. повторный запуск миграции отклоняется, повторная загрузка текстов — без дублей;
    8. откат rollback-v62.sql: функции снова как в v61.3, данные учеников на месте.

  Безопасность:
    - работает только с 127.0.0.1 / localhost и только с базой, имя которой начинается на konspekt_v62_restore;
    - база должна быть ПУСТОЙ (восстановление поверх существующей базы скрипт не делает);
    - другие базы, резервные копии и production не трогает; файлы пишет только в папку -WorkDir (вне репозитория);
    - создаёт в локальном PostgreSQL недостающие роли Supabase (anon, authenticated, service_role, …) БЕЗ входа и
      без пароля — иначе права (GRANT) из копии не восстановятся. Ничего не устанавливает;
    - пароль локального postgres вводится скрыто, хранится только в памяти этого окна и стирается в конце.
  Расширений Supabase (supabase_vault, pg_graphql, pg_net …) в обычном PostgreSQL нет — ошибки восстановления этих
  объектов ожидаемы и печатаются отдельно. Главный признак верной копии — отпечаток структуры приложения = production.

  Запуск (PowerShell, в папке репозитория, ветка feature/v62):
    powershell -ExecutionPolicy Bypass -File .\supabase\release\v62-local-pg17-check.ps1 `
      -Dump "C:\Users\...\Documents\konspekt-backup-ДАТА\konspekt-full.dump" -Seed ..\konspekt-v62\library-seed.sql
#>
param(
  [Parameter(Mandatory = $true)][string]$Dump,
  [Parameter(Mandatory = $true)][string]$Seed,
  [string]$DbHost = '127.0.0.1',
  [int]$DbPort = 55432,
  [string]$DbUser = 'postgres',
  [string]$DbName = 'konspekt_v62_restore_20261029',
  [string]$WorkDir = '',
  [string]$PgBin = '',
  [string]$ExpectFingerprint = 'e1ddba3a557feff102910fb4ba485667',   # production 28–29.10.2026, 138 объектов
  [int]$ExpectObjects = 138
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
function Say([string]$t, [string]$c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Fail([string]$t) { Say ''; Say ('СТОП: ' + $t) 'Red'; $env:PGPASSWORD = $null; exit 1 }
$script:pass = 0; $script:fail = 0
function Check([string]$name, [string]$got, [string]$want) {
  if ($got -eq $want) { $script:pass++; Say ("PASS  $name") 'Green' }
  else { $script:fail++; Say ("FAIL  $name → получено '$got', ожидалось '$want'") 'Red' }
}

# ---------- предохранители ----------
if ($DbHost -notin @('127.0.0.1', 'localhost', '::1')) { Fail "только локальная база (127.0.0.1); указано: $DbHost" }
if ($DbName -notmatch '^konspekt_v62_restore') { Fail "имя базы должно начинаться на konspekt_v62_restore; указано: $DbName" }
if (-not (Test-Path $Dump)) { Fail "нет файла копии: $Dump" }
if (-not (Test-Path $Seed)) { Fail "нет закрытого файла с текстами: $Seed (шаг 0б инструкции)" }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$mig = Join-Path $repo 'supabase\migrations\20261028120000_v62_paid_library.sql'
$rel = Join-Path $repo 'supabase\release'
foreach ($f in @($mig, "$rel\v62-snapshot.sql", "$rel\v62-access-check.sql", "$rel\rollback-v62.sql")) { if (-not (Test-Path $f)) { Fail "нет файла $f (нужна ветка feature/v62)" } }
$seedFull = (Resolve-Path $Seed).Path
if ($seedFull.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase)) { Fail 'library-seed.sql лежит внутри репозитория — перенесите его в ..\konspekt-v62' }
if (-not $WorkDir) { $WorkDir = Join-Path (Split-Path $repo -Parent) ('konspekt-v62\pg17-check-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
if ((Join-Path ([IO.Path]::GetFullPath($WorkDir)) '').StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase)) { Fail 'папка -WorkDir внутри репозитория — укажите папку вне его' }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

function Find-Tool([string]$name) {
  if ($PgBin) { $p = Join-Path $PgBin $name; if (Test-Path $p) { return $p }; if (Test-Path ($p + '.exe')) { return $p + '.exe' } }
  foreach ($v in 18, 17) { $p = "C:\Program Files\PostgreSQL\$v\bin\$name.exe"; if (Test-Path $p) { return $p } }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}
$pgRestore = Find-Tool 'pg_restore'; $psql = Find-Tool 'psql'
if (-not $pgRestore -or -not $psql) { Fail 'не найдены pg_restore / psql. Укажите -PgBin "C:\Program Files\PostgreSQL\17\bin"' }

$env:PGHOST = $DbHost; $env:PGPORT = "$DbPort"; $env:PGUSER = $DbUser; $env:PGCLIENTENCODING = 'UTF8'; $env:PGSSLMODE = 'disable'
if (-not $env:PGPASSWORD) {
  $sec = Read-Host -AsSecureString 'Пароль ЛОКАЛЬНОГО postgres (ввод скрыт)'
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

# Запуск программы с выводом в файлы (stderr PostgreSQL не превращается в ошибку PowerShell). Возвращает код выхода.
$script:n = 0
function Run([string]$exe, [string[]]$a, [string]$tag) {
  $script:n++; $o = Join-Path $WorkDir ('{0:d2}-{1}.out.txt' -f $script:n, $tag); $e = Join-Path $WorkDir ('{0:d2}-{1}.err.txt' -f $script:n, $tag)
  $q = $a | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
  $p = Start-Process -FilePath $exe -ArgumentList $q -NoNewWindow -Wait -PassThru -RedirectStandardOutput $o -RedirectStandardError $e
  $script:lastOut = (Get-Content $o -Encoding UTF8 -ErrorAction SilentlyContinue) -join "`n"
  $script:lastErr = (Get-Content $e -Encoding UTF8 -ErrorAction SilentlyContinue) -join "`n"
  return $p.ExitCode
}
function Q([string]$sql, [string]$db = $DbName) {
  $rc = Run $psql @('-X', '-w', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-d', $db, '-c', $sql) 'q'
  if ($rc -ne 0) { Fail ("запрос не выполнился: " + ($script:lastErr -split "`n" | Select-Object -First 2) -join ' ') }
  return $script:lastOut.Trim()
}
function F([string]$file, [string]$tag) { return (Run $psql @('-X', '-w', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', $DbName, '-f', $file) $tag) }

try {
  # ---------- 0. сервер и пустая база ----------
  $ver = Q 'show server_version' 'postgres'
  Say "PostgreSQL на ${DbHost}:${DbPort}: $ver"
  if ([int]($ver -replace '^(\d+).*', '$1') -lt 17) { Fail 'нужен PostgreSQL 17 (как в Supabase)' }
  if ((Q "select count(*) from pg_database where datname = '$DbName'" 'postgres') -ne '1') { Fail "нет базы $DbName — создайте пустую: createdb -h 127.0.0.1 -p $DbPort -U postgres $DbName" }
  $objs = Q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'"
  if ($objs -ne '0') { Fail "база $DbName не пустая ($objs объектов). Восстановление поверх существующей базы не выполняется: создайте новую пустую базу и укажите -DbName" }

  # ---------- 1. роли Supabase (без входа) и восстановление копии ----------
  $roles = @('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin',
             'supabase_realtime_admin', 'supabase_replication_admin', 'supabase_read_only_user', 'supabase_functions_admin',
             'supabase_etl_admin', 'dashboard_user', 'pgbouncer')
  $have = (Q "select string_agg(rolname, ',') from pg_roles" 'postgres') -split ','
  $missing = @($roles | Where-Object { $_ -notin $have })
  if ($missing.Count) {
    Say ('Создаю роли Supabase без входа: ' + ($missing -join ', ')) 'Yellow'
    foreach ($r in $missing) { Q "create role $r nologin" 'postgres' | Out-Null }
  }
  if ((Q "select count(*) from pg_roles where rolname = 'postgres' and rolsuper" 'postgres') -ne '1') { Fail 'подключение должно быть от суперпользователя postgres' }
  Say 'Восстанавливаю копию (1–3 минуты)…'
  $rc = Run $pgRestore @('-w', '-d', $DbName, $Dump) 'restore'
  $errs = @($script:lastErr -split "`n" | Where-Object { $_ -match 'error:|ОШИБКА|ERROR' })
  $extRe = 'vault|pgsodium|graphql|pg_net|"net"|net\.|supabase_functions|pg_cron|cron\.|realtime|supautils|pgjwt|wrappers|pg_stat_monitor|hypopg|index_advisor|plpgsql_check|pgaudit|extension|расширени'
  $other = @($errs | Where-Object { $_ -notmatch $extRe })
  Say ("pg_restore: код $rc; строк с ошибками: $($errs.Count), из них про расширения Supabase: $($errs.Count - $other.Count), прочих: $($other.Count)")
  $other | Select-Object -First 15 | ForEach-Object { Say ('  ' + $_.Substring(0, [Math]::Min(220, $_.Length))) 'Yellow' }
  Say ("  полный журнал: " + (Join-Path $WorkDir ('{0:d2}-restore.err.txt' -f $script:n)))

  # ---------- 2. структура приложения = production ----------
  $fpSql = @"
select md5(string_agg(f||' '||h, E'\n' order by f)) || '|' || count(*) from (
 select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' f, left(md5(md5(p.prosrc)||p.prosecdef||coalesce(array_to_string(p.proconfig,','),'')||coalesce(array_to_string(p.proacl,','),'')),8) h
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private','analytics')
 union all
 select n.nspname||'.'||c.relname||':'||c.relkind::text, left(md5(c.relrowsecurity::text||':'||coalesce(array_to_string(c.relacl,','),'')),8)
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','analytics') and c.relkind in ('r','v','m','p')
 union all
 select 'policy '||schemaname||'.'||tablename||':'||policyname, left(md5(cmd||':'||array_to_string(roles,',')||':'||coalesce(qual,'')||':'||coalesce(with_check,'')),8) from pg_policies where schemaname in ('public','private','analytics','storage')
) x
"@ -replace "`r?`n", ' '
  $funcsSql = "select md5(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || md5(p.prosrc) || p.prosecdef || coalesce(array_to_string(p.proconfig, ','), '') || coalesce(array_to_string(p.proacl, ','), ''), '|' order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private', 'analytics')"
  Check '1. копия восстановлена: отпечаток структуры приложения = production' (Q $fpSql) "$ExpectFingerprint|$ExpectObjects"
  Check '1. предпроверка (панель есть, библиотеки нет, активных тарифов 0)' (Q "select (to_regclass('private.owner_panel_secrets') is not null)::text || '|' || (to_regclass('private.library_paragraphs') is null)::text || '|' || (select count(*) from private.plans where active)") 'true|true|0'
  $budget = Q "select max_total_starts||'/'||total_starts||'/'||max_in_flight from private.ai_limits"
  Say ("  бюджет ИИ в копии: $budget; пользователей: " + (Q 'select count(*) from auth.users') + '; конспектов: ' + (Q 'select count(*) from public.notes') + '; выдач: ' + (Q 'select count(*) from private.access_grants'))
  $funcs0 = Q $funcsSql

  # ---------- 3. снимок → миграция → снимок ----------
  if ((F "$rel\v62-snapshot.sql" 'snapshot-before') -ne 0) { Fail ('снимок не снялся: ' + $script:lastErr) }
  $snap0 = $script:lastOut.Trim()
  $t0 = Get-Date
  $rc = F $mig 'migration'
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  Check '2. миграция v62 применилась (код psql 0)' "$rc" '0'
  if ($rc -ne 0) { ($script:lastErr -split "`n" | Select-Object -First 5) | ForEach-Object { Say "  $_" 'Red' }; Fail 'миграция не применилась на копии — в production не применять, пришлите Claude эти строки' }
  Say "  время миграции на копии: $ms мс (через psql -f, по одной команде)"
  if ((F "$rel\v62-snapshot.sql" 'snapshot-after') -ne 0) { Fail ('снимок не снялся: ' + $script:lastErr) }
  Check '2. данные учеников после миграции не изменились (снимок 19 таблиц)' $script:lastOut.Trim() $snap0
  Check '2. тарифы: premium 30 дн./10 ген./299 ₽ активен, gift выключен' (Q "select string_agg(code||':'||days||':'||ai_quota||':'||coalesce(price_label,'-')||':'||active, ',' order by code) from private.plans") 'gift:7:1:-:false,premium:30:10:299 ₽:true'
  Check '2. закрытая таблица: RLS включена, anon/authenticated прав не имеют' (Q "select c.relrowsecurity::text || '|' || has_table_privilege('anon', c.oid, 'select')::text || '|' || has_table_privilege('authenticated', c.oid, 'select')::text from pg_class c where c.oid = 'private.library_paragraphs'::regclass") 'true|false|false'
  Check '2. чтение библиотеки: вошедшим — через функцию, гостям без входа (anon) — нет' (Q "select has_function_privilege('authenticated', 'public.get_library_paragraph(text, text, text)', 'execute')::text || '|' || has_function_privilege('anon', 'public.get_library_paragraph(text, text, text)', 'execute')::text") 'true|false'

  # ---------- 4. перенос 77 параграфов ----------
  $rc = F $seedFull 'seed'
  Check '3. загрузка текстов: контрольные суммы 77 параграфов совпали' "$rc/$([int]($script:lastErr -match 'совпали: 77'))" '0/1'
  Check '3. в таблице 77 параграфов: history 26, physics 51' (Q "select string_agg(subject_id||':'||c, ',' order by subject_id) from (select subject_id, count(*) c from private.library_paragraphs group by 1) s") 'history:26,physics:51'
  Check '3. дублей и пустых текстов нет' (Q "select count(*) - count(distinct (subject_id, book_id, paragraph_id)) + count(*) filter (where content is null or content = '{}'::jsonb) from private.library_paragraphs") '0'
  if ((F "$rel\v62-access-check.sql" 'access') -ne 0) { Fail ('проверка доступа не выполнилась: ' + $script:lastErr) }
  Say '  проверка доступа (статус | ID | результат):'
  $acc = @($script:lastOut.Trim() -split "`n" | Where-Object { $_ })
  $acc | ForEach-Object { Say "    $_" }
  $wrong = @($acc | Where-Object { ($_ -match '^(owner|trial|paid)\|' -and $_ -notmatch '\|text$') -or ($_ -match '^(expired|none)\|' -and $_ -notmatch '\|ACCESS_REQUIRED$') })
  Check '3. доступ: владелец/пробный/оплаченный → текст, без доступа → ACCESS_REQUIRED' "$($wrong.Count)" '0'

  # ---------- 5. повторы ----------
  $f1 = Q $funcsSql
  $rc = F $mig 'migration-again'
  Check '4. повторный запуск миграции отклонён, функции не изменились' "$rc/$(Q $funcsSql)" "3/$f1"
  $rc = F $seedFull 'seed-again'
  Check '4. повторная загрузка текстов — без дублей' "$rc/$(Q 'select count(*) from private.library_paragraphs')" '0/77'

  # ---------- 6. откат ----------
  $rc = F "$rel\rollback-v62.sql" 'rollback'
  Check '5. откат rollback-v62.sql применился' "$rc" '0'
  Check '5. после отката функции = как до миграции (v61.3)' (Q $funcsSql) $funcs0
  if ((F "$rel\v62-snapshot.sql" 'snapshot-rollback') -ne 0) { Fail ('снимок не снялся: ' + $script:lastErr) }
  Check '5. после отката данные учеников = как до миграции' $script:lastOut.Trim() $snap0
  Check '5. после отката закрытой таблицы нет' (Q "select (to_regclass('private.library_paragraphs') is null)::text") 'true'
}
finally {
  $env:PGPASSWORD = $null
}

Say ''
Say ("Итого: PASS $script:pass, FAIL $script:fail. Файлы проверки: $WorkDir (не публиковать: в журналах есть структура базы)")
if ($script:fail -eq 0) {
  Say 'РЕПЕТИЦИЯ v62 НА КОПИИ PRODUCTION ПРОЙДЕНА' 'Green'
  Say 'Пришлите Claude строки PASS/FAIL и строку pg_restore (без файлов из папки проверки).'
} else {
  Say 'РЕПЕТИЦИЯ НЕ ПРОЙДЕНА — в production ничего не применять. Пришлите Claude строки FAIL и строку pg_restore.' 'Red'
  exit 1
}
Say "База $DbName оставлена как есть (после отката). Удалять её или нет — решает владелец."
