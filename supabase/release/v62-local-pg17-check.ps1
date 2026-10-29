<#
  Konspekt by NK — генеральная репетиция v62 на СВОЁМ компьютере (НЕ production).

  Берёт резервную копию production (konspekt-full.dump из backup-before-v62.ps1), восстанавливает её в ПУСТУЮ локальную
  базу konspekt_v62_restore_20261029 (PostgreSQL 17, 127.0.0.1:55432) и проходит весь выпуск как в v62-paid-library.md:
    1. копия: файл не изменился (SHA-256 до/после и с README.txt копии);
    2. восстановление и сверка: структура приложения = production ОБЪЕКТ В ОБЪЕКТ (v62-prod-structure.tsv, 138 объектов),
       число строк каждой таблицы = числу строк в копии;
    3. снимок данных → миграция v62 → снимок: данные учеников не изменились;
    4. 77 параграфов (закрытый library-seed.sql, контрольная сумма каждого) и проверка доступа по ролям;
    5. повторный запуск миграции отклоняется, повторная загрузка текстов — без дублей;
    6. откат rollback-v62.sql: функции снова как в v61.3, данные учеников на месте.
  Если восстановление неполное (не совпала структура или число строк) — скрипт ОСТАНАВЛИВАЕТСЯ до миграции и так и пишет:
  частичное восстановление полноценной проверкой не считается.

  Безопасность (всё проверяется до первого изменения):
    - только 127.0.0.1, порт 55432 и база konspekt_v62_restore_20261029 (или _2 … _9 через -Attempt для повторной попытки);
      после подключения сервер сам подтверждает адрес и порт; переменные PGHOSTADDR/PGSERVICE/PGOPTIONS очищаются,
      чтобы подключение не ушло на другой сервер; к production скрипт не подключается;
    - база должна быть ПУСТОЙ; восстановление поверх существующей базы, удаление и создание баз скрипт не делает;
    - копию только читает; все файлы пишет в -WorkDir (вне репозитория и вне папки копии);
    - объекты расширения supabase_vault (секреты Supabase) пропускаются по оглавлению копии и не восстанавливаются:
      приложение vault не использует (проверено в production 29.10). Нужен pgcrypto — он есть в стандартном PostgreSQL;
    - роли Supabase (anon, authenticated, service_role, …) — общие для всего локального PostgreSQL. Скрипт создаёт их
      ТОЛЬКО с ключом -CreateMissingRoles (NOLOGIN: без входа, без пароля, без прав); без ключа — список и остановка;
    - пароль локального postgres вводится скрыто, хранится только в памяти этого окна и стирается в конце.

  Запуск (PowerShell, в папке репозитория, ветка feature/v62):
    powershell -ExecutionPolicy Bypass -File .\supabase\release\v62-local-pg17-check.ps1 `
      -Dump "C:\Users\...\Documents\konspekt-backup-ДАТА\konspekt-full.dump" -Seed ..\konspekt-v62\library-seed.sql
#>
param(
  [Parameter(Mandatory = $true)][string]$Dump,
  [Parameter(Mandatory = $true)][string]$Seed,
  [int]$Attempt = 1,
  [switch]$CreateMissingRoles,
  [string]$WorkDir = '',
  [string]$PgBin = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$DbHost = '127.0.0.1'; $DbPort = 55432; $DbUser = 'postgres'
$DbName = 'konspekt_v62_restore_20261029'
if ($Attempt -lt 1 -or $Attempt -gt 9) { Write-Host 'СТОП: -Attempt от 1 до 9' -ForegroundColor Red; exit 1 }
if ($Attempt -gt 1) { $DbName = $DbName + '_' + $Attempt }

$script:report = New-Object System.Collections.Generic.List[string]
function Say([string]$t, [string]$c = 'Gray') { Write-Host $t -ForegroundColor $c; $script:report.Add($t) }
function Save-Report { if ($WorkDir -and (Test-Path $WorkDir)) { $script:report | Set-Content -Path (Join-Path $WorkDir 'report.txt') -Encoding UTF8 } }
function Fail([string]$t) { Say ''; Say ('СТОП: ' + $t) 'Red'; Save-Report; $env:PGPASSWORD = $null; exit 1 }
$script:pass = 0; $script:fail = 0
function Check([string]$name, [string]$got, [string]$want) {
  if ($got -eq $want) { $script:pass++; Say ("PASS  $name") 'Green'; return $true }
  $script:fail++; Say ("FAIL  $name → получено '$got', ожидалось '$want'") 'Red'; return $false
}

# ---------- 0. файлы и папки ----------
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$rel = Join-Path $repo 'supabase\release'
$mig = Join-Path $repo 'supabase\migrations\20261028120000_v62_paid_library.sql'
$structFile = Join-Path $rel 'v62-prod-structure.tsv'
foreach ($f in @($mig, $structFile, "$rel\v62-snapshot.sql", "$rel\v62-access-check.sql", "$rel\rollback-v62.sql")) {
  if (-not (Test-Path $f)) { Fail "нет файла $f (нужна ветка feature/v62)" }
}
if (-not (Test-Path $Dump -PathType Leaf)) { Fail "нет файла копии: $Dump" }
if (-not (Test-Path $Seed -PathType Leaf)) { Fail "нет закрытого файла с текстами: $Seed (шаг 0б инструкции)" }
$dumpFull = (Resolve-Path $Dump).Path; $seedFull = (Resolve-Path $Seed).Path
$dumpDir = Split-Path $dumpFull -Parent
function Inside([string]$p, [string]$dir) { $a = [IO.Path]::GetFullPath($p).TrimEnd('\') + '\'; $b = [IO.Path]::GetFullPath($dir).TrimEnd('\') + '\'; return $a.StartsWith($b, [StringComparison]::OrdinalIgnoreCase) }
if (Inside $seedFull $repo) { Fail 'library-seed.sql лежит внутри репозитория — перенесите его в ..\konspekt-v62' }
if (-not $WorkDir) { $WorkDir = Join-Path (Split-Path $repo -Parent) ('konspekt-v62\pg17-check-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$WorkDir = [IO.Path]::GetFullPath($WorkDir)
if (Inside $WorkDir $repo) { Fail 'папка -WorkDir внутри репозитория — укажите папку вне его' }
if (Inside $WorkDir $dumpDir) { Fail 'папка -WorkDir внутри папки резервной копии — копию не трогаем, укажите другую папку' }
if ((Test-Path $WorkDir) -and @(Get-ChildItem $WorkDir -Force).Count) { Fail "папка $WorkDir не пустая — укажите новую" }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

function Find-Tool([string]$name) {
  if ($PgBin) { $p = Join-Path $PgBin ($name + '.exe'); if (Test-Path $p) { return $p }; $p = Join-Path $PgBin $name; if (Test-Path $p) { return $p } }
  foreach ($v in 18, 17) { $p = "C:\Program Files\PostgreSQL\$v\bin\$name.exe"; if (Test-Path $p) { return $p } }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}
$pgRestore = Find-Tool 'pg_restore'; $psql = Find-Tool 'psql'
if (-not $pgRestore -or -not $psql) { Fail 'не найдены pg_restore / psql. Укажите -PgBin "C:\Program Files\PostgreSQL\17\bin"' }

# копия: SHA-256 сейчас и (если есть) из README.txt, который записал backup-before-v62.ps1
$sha0 = (Get-FileHash $dumpFull -Algorithm SHA256).Hash
Say "Копия: $dumpFull ($((Get-Item $dumpFull).Length) байт), SHA-256 $sha0"
$readme = Join-Path $dumpDir 'README.txt'
if (Test-Path $readme) {
  $line = Get-Content $readme -Encoding UTF8 | Where-Object { $_ -match ('^' + [regex]::Escape((Split-Path $dumpFull -Leaf)) + '\s.*SHA256\s+([0-9A-Fa-f]{64})') } | Select-Object -First 1
  if ($line -and $line -match 'SHA256\s+([0-9A-Fa-f]{64})') { [void](Check '0. копия цела: SHA-256 = записанной при создании (README.txt)' $sha0 $Matches[1].ToUpper()) }
  else { Say '  в README.txt нет строки с SHA-256 этого файла — сверка с моментом создания пропущена' 'Yellow' }
} else { Say '  README.txt рядом с копией нет — сверка с моментом создания пропущена' 'Yellow' }
if ($script:fail) { Fail 'файл копии отличается от созданного — повреждён или не тот; репетицию не продолжаю' }

# ---------- подключение: только локальный сервер ----------
foreach ($v in 'PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGDATABASE', 'PGREQUIRESSL', 'PGTARGETSESSIONATTRS') { Remove-Item "Env:\$v" -ErrorAction SilentlyContinue }
$env:PGHOST = $DbHost; $env:PGPORT = "$DbPort"; $env:PGUSER = $DbUser; $env:PGCLIENTENCODING = 'UTF8'; $env:PGSSLMODE = 'disable'; $env:PGCONNECT_TIMEOUT = '10'
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
  $script:lastErrFile = $e
  return $p.ExitCode
}
function Q([string]$sql, [string]$db = $DbName) {
  $rc = Run $psql @('-X', '-w', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-d', $db, '-c', $sql) 'q'
  if ($rc -ne 0) { Fail ('запрос не выполнился: ' + (($script:lastErr -split "`n" | Select-Object -First 3) -join ' ')) }
  return $script:lastOut.Trim()
}
function F([string]$file, [string]$tag) { return (Run $psql @('-X', '-w', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', $DbName, '-f', $file) $tag) }
function Lines([string]$s) { return @($s -split "`n" | ForEach-Object { $_.TrimEnd("`r") } | Where-Object { $_ -ne '' -and $_ -ne 'BEGIN' -and $_ -ne 'COMMIT' }) }

try {
  # ---------- 1. сервер, база, расширения, роли (только чтение) ----------
  $who = Q "select coalesce(host(inet_server_addr()), 'socket') || '|' || inet_server_port() || '|' || current_setting('server_version_num') || '|' || (select rolsuper from pg_roles where rolname = current_user)::text" 'postgres'
  $srv = $who.Split('|')
  if ($srv[0] -ne '127.0.0.1' -or $srv[1] -ne "$DbPort") { Fail "сервер ответил с адреса $($srv[0]):$($srv[1]) — ожидался 127.0.0.1:$DbPort" }
  if ([int]$srv[2] -lt 170000) { Fail "PostgreSQL $($srv[2]) — нужен 17 (как в Supabase)" }
  if ($srv[3] -ne 'true') { Fail 'подключение должно быть от суперпользователя postgres (локального)' }
  if ((Q "select count(*) from pg_extension where extname = 'supabase_vault'" 'postgres') -ne '0') { Fail 'на этом сервере есть supabase_vault — похоже на Supabase, а не на локальный PostgreSQL' }
  Say ("Сервер: 127.0.0.1:$DbPort, PostgreSQL " + (Q 'show server_version' 'postgres'))
  if ((Q "select count(*) from pg_database where datname = '$DbName'" 'postgres') -ne '1') { Fail "нет базы $DbName. Создайте пустую: createdb -h 127.0.0.1 -p $DbPort -U postgres $DbName" }
  $objs = Q "select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)') + (select count(*) from pg_namespace where nspname not in ('public', 'pg_catalog', 'information_schema') and nspname !~ '^pg_') + (select count(*) from pg_extension where extname <> 'plpgsql') + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public')"
  if ($objs -ne '0') { Fail "база $DbName не пустая ($objs объектов). Поверх существующей базы не восстанавливаю: создайте новую пустую и запустите с -Attempt $($Attempt + 1)" }

  $avail = (Q "select string_agg(name, ',') from pg_available_extensions") -split ','
  $toc = @(& $pgRestore -l $dumpFull)
  if ($LASTEXITCODE -ne 0 -or -not $toc.Count) { Fail 'pg_restore не читает оглавление копии' }
  $dumpExt = @($toc | Where-Object { $_ -match '^\d+; \d+ \d+ EXTENSION - (\S+)' } | ForEach-Object { $_ -replace '^\d+; \d+ \d+ EXTENSION - (\S+).*', '$1' })
  $noExt = @($dumpExt | Where-Object { $_ -notin $avail })
  Say ('Расширения в копии: ' + ($dumpExt -join ', ') + '; нет в этом PostgreSQL: ' + $(if ($noExt.Count) { $noExt -join ', ' } else { 'все есть' }))
  $critical = @($noExt | Where-Object { $_ -ne 'supabase_vault' })
  if ($critical.Count) { Fail ('в этом PostgreSQL нет расширений ' + ($critical -join ', ') + ' — без них функции приложения восстановятся не полностью. Полноценная проверка невозможна; напишите Claude') }

  $roles = @('anon', 'authenticated', 'service_role', 'authenticator', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin',
             'supabase_realtime_admin', 'supabase_replication_admin', 'supabase_read_only_user', 'dashboard_user', 'pgbouncer')
  $have = (Q "select string_agg(rolname, ',') from pg_roles" 'postgres') -split ','
  $missing = @($roles | Where-Object { $_ -notin $have })
  if ($missing.Count) {
    if (-not $CreateMissingRoles) {
      Fail ('в локальном PostgreSQL нет ролей Supabase: ' + ($missing -join ', ') + '. Без них права (GRANT) из копии не восстановятся. ' +
            'Роли общие для всего локального сервера: запустите с ключом -CreateMissingRoles — они будут созданы без входа и без пароля ' +
            '(убрать потом: drop role <имя>, после удаления тестовой базы)')
    }
    Say ('Создаю роли Supabase без входа и без пароля (ключ -CreateMissingRoles): ' + ($missing -join ', ')) 'Yellow'
    foreach ($r in $missing) { Q "create role $r nologin" 'postgres' | Out-Null }
  }

  # ---------- 2. восстановление: всё, кроме объектов supabase_vault ----------
  $skip = @($toc | Where-Object { $_ -match '^\d+; \d+ \d+ (EXTENSION - supabase_vault|COMMENT - EXTENSION supabase_vault|[A-Z][A-Z ]* vault |SCHEMA - vault |ACL - SCHEMA vault )' })
  $keep = @($toc | Where-Object { $_ -notin $skip })
  $list = Join-Path $WorkDir 'restore-list.txt'
  $keep | Set-Content -Path $list -Encoding ASCII
  Say ("Восстанавливаю копию (1–3 минуты). Пропущено объектов supabase_vault: $($skip.Count) — их данные (секреты Supabase) не нужны приложению")
  $rc = Run $pgRestore @('-w', '-d', $DbName, '-L', $list, $dumpFull) 'restore'
  $errs = @(Lines $script:lastErr | Where-Object { $_ -match 'error:' })
  Say ("pg_restore: код $rc, ошибок: $($errs.Count). Полный журнал: $script:lastErrFile") $(if ($errs.Count) { 'Yellow' } else { 'Gray' })
  $errLines = @(Lines $script:lastErr)
  for ($i = 0; $i -lt $errLines.Count -and $i -lt 60; $i++) { $x = $errLines[$i]; Say ('  ' + $x.Substring(0, [Math]::Min(240, $x.Length))) 'Yellow' }
  if ($errLines.Count -gt 60) { Say "  … ещё $($errLines.Count - 60) строк — в журнале" 'Yellow' }

  # структура приложения: объект в объект с production
  $structSql = "select f || chr(9) || h from (select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' f, left(md5(md5(p.prosrc)||p.prosecdef||coalesce(array_to_string(p.proconfig,','),'')||coalesce(array_to_string(p.proacl,','),'')),8) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private','analytics') union all select n.nspname||'.'||c.relname||':'||c.relkind::text, left(md5(c.relrowsecurity::text||':'||coalesce(array_to_string(c.relacl,','),'')),8) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','analytics') and c.relkind in ('r','v','m','p') union all select 'policy '||schemaname||'.'||tablename||':'||policyname, left(md5(cmd||':'||array_to_string(roles,',')||':'||coalesce(qual,'')||':'||coalesce(with_check,'')),8) from pg_policies where schemaname in ('public','private','analytics','storage')) x order by 1"
  $want = @{}; Get-Content $structFile -Encoding UTF8 | Where-Object { $_ -and -not $_.StartsWith('#') } | ForEach-Object { $k, $h = $_.Split("`t"); $want[$k] = $h }
  $got = @{}; Lines (Q $structSql) | ForEach-Object { $k, $h = $_.Split("`t"); $got[$k] = $h }
  $diff = @()
  foreach ($k in $want.Keys) { if (-not $got.ContainsKey($k)) { $diff += "нет: $k" } elseif ($got[$k] -ne $want[$k]) { $diff += "отличается: $k" } }
  foreach ($k in $got.Keys) { if (-not $want.ContainsKey($k)) { $diff += "лишний: $k" } }
  $structOk = Check "1. структура приложения = production ($($want.Count) объектов: функции, таблицы, права, RLS, политики)" "$($diff.Count)" '0'
  $diff | Sort-Object | Select-Object -First 30 | ForEach-Object { Say "    $_" 'Red' }

  # число строк: каждая таблица в копии (COPY-блоки) = в восстановленной базе
  $copy = @{}; $cur = $null; $cnt = 0
  foreach ($line in (& $pgRestore -f - --data-only -L $list $dumpFull)) {
    if ($line -match '^COPY ([\w"]+)\.([\w"]+) ') { $cur = ($Matches[1] + '.' + $Matches[2]).Replace('"', ''); $cnt = 0; continue }
    if ($cur) { if ($line -eq '\.') { $copy[$cur] = $cnt; $cur = $null } else { $cnt++ } }
  }
  if ($LASTEXITCODE -ne 0) { Fail 'pg_restore не читает данные копии' }
  $vals = ($copy.Keys | Sort-Object | ForEach-Object { $s, $tn = $_.Split('.'); "('" + $s.Replace("'", "''") + "', '" + $tn.Replace("'", "''") + "')" }) -join ', '
  $restored = @{}
  if ($copy.Count) {
    Lines (Q ("select s || '.' || t || chr(9) || case when to_regclass(format('%I.%I', s, t)) is null then '-1' " +
              "else (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', s, t), false, true, '')))[1]::text end " +
              "from (values $vals) v(s, t)")) | ForEach-Object { $k, $c = $_.Split("`t"); $restored[$k] = $c }
  }
  $rowsBad = @()
  foreach ($t in ($copy.Keys | Sort-Object)) {
    $have = $restored[$t]
    if ("$have" -ne "$($copy[$t])") { $rowsBad += "$t — в копии $($copy[$t]), восстановлено $(if ($have -eq '-1') { 'нет таблицы' } else { $have })" }
  }
  $appRows = @('auth.users', 'public.notes', 'private.access_grants', 'private.user_entitlements', 'private.ai_limits') | ForEach-Object { "$_ $($copy[$_])" }
  $rowsOk = Check ("1. число строк всех $($copy.Count) таблиц = в копии (" + ($appRows -join ', ') + ')') "$($rowsBad.Count)" '0'
  $rowsBad | Select-Object -First 30 | ForEach-Object { Say "    $_" 'Red' }
  [void](Check '1. pgcrypto на месте (пароль панели владельца)' (Q "select (to_regprocedure('extensions.crypt(text, text)') is not null)::text") 'true')

  if (-not $structOk -or -not $rowsOk -or $script:fail) {
    Fail ('ВОССТАНОВЛЕНИЕ НЕПОЛНОЕ: копия восстановилась частично (см. строки FAIL и журнал pg_restore). ' +
          'Это не полноценная проверка — миграцию на ней не запускаю. Пришлите Claude строки FAIL и ошибки pg_restore')
  }
  Say ('Восстановление ПОЛНОЕ для приложения: структура и данные совпали' + $(if ($errs.Count) { "; ошибки pg_restore ($($errs.Count)) не задели объекты и данные приложения — они перечислены выше" } else { '' })) 'Green'

  # ---------- 3. снимок → миграция → снимок ----------
  $funcsSql = "select md5(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || md5(p.prosrc) || p.prosecdef || coalesce(array_to_string(p.proconfig, ','), '') || coalesce(array_to_string(p.proacl, ','), ''), '|' order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private', 'analytics')"
  [void](Check '2. предпроверка: панель есть, библиотеки нет, тарифов 0 (private.plans пустая, как в production)' (Q "select (to_regclass('private.owner_panel_secrets') is not null)::text || '|' || (to_regclass('private.library_paragraphs') is null)::text || '|' || (select count(*) from private.plans)") 'true|true|0')
  Say ('  бюджет ИИ в копии: ' + (Q "select max_total_starts||'/'||total_starts||'/'||max_in_flight from private.ai_limits"))
  $funcs0 = Q $funcsSql
  if ((F "$rel\v62-snapshot.sql" 'snapshot-before') -ne 0) { Fail ('снимок не снялся: ' + $script:lastErr) }
  $snap0 = $script:lastOut.Trim()
  $t0 = Get-Date
  $rc = F $mig 'migration'
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  if (-not (Check '2. миграция v62 применилась (код psql 0)' "$rc" '0')) {
    (Lines $script:lastErr | Select-Object -First 8) | ForEach-Object { Say "  $_" 'Red' }
    Fail 'миграция не применилась на копии production — в production не применять, пришлите Claude эти строки'
  }
  Say "  время миграции на копии: $ms мс (psql -f, по одной команде; в production — одним запросом)"
  if ((F "$rel\v62-snapshot.sql" 'snapshot-after') -ne 0) { Fail ('снимок не снялся: ' + $script:lastErr) }
  [void](Check '2. данные учеников после миграции не изменились (снимок 19 таблиц)' $script:lastOut.Trim() $snap0)
  [void](Check '2. тарифы: premium 30 дн./10 ген./299 ₽ активен, gift выключен' (Q "select string_agg(code||':'||days||':'||ai_quota||':'||coalesce(price_label,'-')||':'||active, ',' order by code) from private.plans") 'gift:7:1:-:false,premium:30:10:299 ₽:true')
  [void](Check '2. закрытая таблица: RLS включена, у anon/authenticated/service_role прав нет' (Q "select c.relrowsecurity::text || '|' || has_table_privilege('anon', c.oid, 'select')::text || '|' || has_table_privilege('authenticated', c.oid, 'select')::text || '|' || has_table_privilege('service_role', c.oid, 'select')::text from pg_class c where c.oid = 'private.library_paragraphs'::regclass") 'true|false|false|false')
  [void](Check '2. чтение библиотеки: вошедшим — через функцию, гостям без входа (anon) — нет' (Q "select has_function_privilege('authenticated', 'public.get_library_paragraph(text, text, text)', 'execute')::text || '|' || has_function_privilege('anon', 'public.get_library_paragraph(text, text, text)', 'execute')::text") 'true|false')

  # ---------- 4. перенос 77 параграфов ----------
  $rc = F $seedFull 'seed'
  [void](Check '3. загрузка текстов: контрольные суммы 77 параграфов совпали' "$rc/$([int]($script:lastErr -match 'совпали: 77'))" '0/1')
  [void](Check '3. в таблице 77 параграфов: history 26, physics 51' (Q "select string_agg(subject_id||':'||c, ',' order by subject_id) from (select subject_id, count(*) c from private.library_paragraphs group by 1) s") 'history:26,physics:51')
  [void](Check '3. дублей и пустых текстов нет' (Q "select count(*) - count(distinct (subject_id, book_id, paragraph_id)) + count(*) filter (where content is null or content = '{}'::jsonb) from private.library_paragraphs") '0')
  if ((F "$rel\v62-access-check.sql" 'access') -ne 0) { Fail ('проверка доступа не выполнилась: ' + $script:lastErr) }
  $acc = @(Lines $script:lastOut)
  Say ('  доступ по статусам (статус → результат): ' + (($acc | ForEach-Object { $p = $_.Split('|'); $p[0] + ' → ' + $p[-1] }) -join '; '))
  $wrong = @($acc | Where-Object { ($_ -match '^(owner|trial|paid)\|' -and $_ -notmatch '\|text$') -or ($_ -notmatch '^(owner|trial|paid)\|' -and $_ -notmatch '\|ACCESS_REQUIRED$') })
  [void](Check '3. доступ: владелец/пробный/оплаченный → текст, остальные → ACCESS_REQUIRED' "$($wrong.Count)" '0')

  # ---------- 5. повторы ----------
  $f1 = Q $funcsSql
  $rc = F $mig 'migration-again'
  [void](Check '4. повторный запуск миграции отклонён, функции не изменились' "$rc/$(Q $funcsSql)" "3/$f1")
  $rc = F $seedFull 'seed-again'
  [void](Check '4. повторная загрузка текстов — без дублей' "$rc/$(Q 'select count(*) from private.library_paragraphs')" '0/77')

  # ---------- 6. откат ----------
  $rc = F "$rel\rollback-v62.sql" 'rollback'
  [void](Check '5. откат rollback-v62.sql применился' "$rc" '0')
  [void](Check '5. после отката функции = как до миграции (v61.3)' (Q $funcsSql) $funcs0)
  if ((F "$rel\v62-snapshot.sql" 'snapshot-rollback') -ne 0) { Fail ('снимок не снялся: ' + $script:lastErr) }
  [void](Check '5. после отката данные учеников = как до миграции' $script:lastOut.Trim() $snap0)
  [void](Check '5. после отката закрытой таблицы нет' (Q "select (to_regclass('private.library_paragraphs') is null)::text") 'true')

  [void](Check '6. файл копии не изменился за репетицию (SHA-256)' (Get-FileHash $dumpFull -Algorithm SHA256).Hash $sha0)
}
finally {
  $env:PGPASSWORD = $null
}

Say ''
Say ("Итого: PASS $script:pass, FAIL $script:fail. Отчёт: " + (Join-Path $WorkDir 'report.txt'))
if ($script:fail -eq 0) {
  Say 'РЕПЕТИЦИЯ v62 НА КОПИИ PRODUCTION ПРОЙДЕНА' 'Green'
  Say 'Пришлите Claude файл report.txt (в нём нет паролей, текстов и данных учеников). Остальные файлы папки не пересылать.'
} else {
  Say 'РЕПЕТИЦИЯ НЕ ПРОЙДЕНА — в production ничего не применять. Пришлите Claude файл report.txt.' 'Red'
}
Say "База $DbName оставлена как есть (после отката). Удалять её или нет — решает владелец."
Save-Report
if ($script:fail) { exit 1 }
