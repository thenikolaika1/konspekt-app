<#
  Konspekt by NK — диагностика репетиции v62 (ТОЛЬКО ЧТЕНИЕ, НЕ production).

  Отвечает на два вопроса по прошлой репетиции и ничего не меняет:
    1. Почему не загрузился library-seed.sql: шапка файла (SHA-256 исходника, число параграфов) против манифеста
       и строки ERROR из журнала загрузки (там только идентификаторы параграфов, без текстов).
    2. Какие функции после отката отличаются от состояния до миграции: сравнивает базу первой репетиции
       (konspekt_v62_restore_20261029 — копия сразу после восстановления) с базой второй (…_2 — после отката).
       Печатает имя функции, владельца, SECURITY DEFINER, search_path, права и md5 текста функции — без данных учеников.

  Безопасность: только 127.0.0.1:55432 и базы konspekt_v62_restore_20261029[_N]; каждое подключение — только чтение
  (default_transaction_read_only=on); файлы не меняет, кроме записи diag.txt в папку отчёта.

  Запуск (PowerShell, в папке репозитория):
    powershell -ExecutionPolicy Bypass -File .\supabase\release\v62-diag.ps1 -ReportDir C:\Users\...\konspekt-v62\pg17-check-ДАТА -Seed ..\konspekt-v62\library-seed.sql
#>
param(
  [Parameter(Mandatory = $true)][string]$ReportDir,
  [Parameter(Mandatory = $true)][string]$Seed,
  [int]$Before = 1,
  [int]$After = 2,
  [string]$PgBin = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$out = New-Object System.Collections.Generic.List[string]
function Say([string]$t, [string]$c = 'Gray') { Write-Host $t -ForegroundColor $c; $out.Add($t) }
function Fail([string]$t) { Say ('СТОП: ' + $t) 'Red'; $env:PGPASSWORD = $null; exit 1 }
function DbName([int]$a) { if ($a -le 1) { 'konspekt_v62_restore_20261029' } else { 'konspekt_v62_restore_20261029_' + $a } }
if ($Before -lt 1 -or $Before -gt 9 -or $After -lt 1 -or $After -gt 9) { Fail '-Before и -After от 1 до 9' }
if (-not (Test-Path $ReportDir -PathType Container)) { Fail "нет папки отчёта: $ReportDir" }
if (-not (Test-Path $Seed -PathType Leaf)) { Fail "нет файла: $Seed" }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$manifest = Join-Path $repo 'supabase\release\v62-library-manifest.tsv'

# ---------- 1. файл загрузки текстов ----------
Say '== 1. library-seed.sql'
$head = @(Get-Content $Seed -Encoding UTF8 -TotalCount 3)
$want = ((Get-Content $manifest -Encoding UTF8) | Where-Object { $_ -match '^# source-sha256 ([0-9a-f]{64})' } | Select-Object -First 1) -replace '^# source-sha256 ([0-9a-f]{64}).*$', '$1'
$got = if ($head.Count -ge 2 -and $head[1] -match 'sha256 ([0-9a-f]{64})') { $Matches[1] } else { '(нет в шапке)' }
Say ("  SHA-256 исходника в шапке файла: $got")
Say ("  ожидается (манифест):            $want")
if ($head.Count -ge 3) { Say ('  ' + $head[2].Substring(0, [Math]::Min(160, $head[2].Length))) }
if ($got -eq $want) { Say '  исходник верный' 'Green' } else { Say '  ИСХОДНИК НЕ ТОТ: файл собран не из git 53d3203 байт в байт (например, перекодирован при сохранении)' 'Red' }
foreach ($f in @(Get-ChildItem -Path $ReportDir -Filter '*seed*.err.txt' | Sort-Object Name)) {
  Say ("  журнал " + $f.Name + ':')
  $lines = @(Get-Content $f.FullName -Encoding UTF8 | Where-Object { $_ -match '^psql:.*(ERROR|ОШИБКА)' -or $_ -match '^(ERROR|ОШИБКА):' })
  if (-not $lines.Count) { Say '    строк ERROR нет' }
  $lines | Select-Object -First 5 | ForEach-Object { $x = $_ -replace '^psql:.*?:(\d+): ', 'строка $1: '; Say ('    ' + $x.Substring(0, [Math]::Min(300, $x.Length))) 'Yellow' }
}

# ---------- 2. функции: до миграции против после отката ----------
function Find-Tool([string]$name) {
  if ($PgBin) { $p = Join-Path $PgBin ($name + '.exe'); if (Test-Path $p) { return $p } }
  foreach ($v in 18, 17) { $p = "C:\Program Files\PostgreSQL\$v\bin\$name.exe"; if (Test-Path $p) { return $p } }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}
$psql = Find-Tool 'psql'
if (-not $psql) { Fail 'не найден psql. Укажите -PgBin "C:\Program Files\PostgreSQL\17\bin"' }
foreach ($v in 'PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGDATABASE', 'PGREQUIRESSL', 'PGTARGETSESSIONATTRS') { Remove-Item "Env:\$v" -ErrorAction SilentlyContinue }
$env:PGHOST = '127.0.0.1'; $env:PGPORT = '55432'; $env:PGUSER = 'postgres'; $env:PGCLIENTENCODING = 'UTF8'; $env:PGSSLMODE = 'disable'
$env:PGOPTIONS = '-c default_transaction_read_only=on -c lc_messages=C'; $env:LC_MESSAGES = 'C'; $env:LANGUAGE = 'en'
if (-not $env:PGPASSWORD) {
  $sec = Read-Host -AsSecureString 'Пароль ЛОКАЛЬНОГО postgres (ввод скрыт)'
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
$fsql = "select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' || chr(9) || 'owner='||pg_get_userbyid(p.proowner)||' secdef='||p.prosecdef::text||' config='||coalesce(array_to_string(p.proconfig,','),'-')||' acl='||coalesce(array_to_string(p.proacl,','),'NULL')||' src='||left(md5(p.prosrc),12) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private','analytics') order by 1"
function Funcs([string]$db) {
  $r = @{}
  $lines = & $psql -X -w -A -t -v ON_ERROR_STOP=1 -d $db -c "select coalesce(host(inet_server_addr()), 'socket') || ':' || inet_server_port() || ' ro=' || current_setting('transaction_read_only')" -c $fsql
  if ($LASTEXITCODE -ne 0) { Fail "не удалось прочитать базу $db" }
  $lines = @($lines)
  if ($lines[0] -ne '127.0.0.1:55432 ro=on') { Fail "неожиданное подключение: $($lines[0])" }
  $lines | Select-Object -Skip 1 | Where-Object { $_ } | ForEach-Object { $k, $d = $_.Split("`t"); $r[$k] = $d }
  return $r
}
try {
  $dbA = DbName $Before; $dbB = DbName $After
  Say "== 2. функции: $dbA (до миграции) против $dbB (после отката)"
  $a = Funcs $dbA; $b = Funcs $dbB
  Say ("  функций: до $($a.Count), после $($b.Count)")
  $n = 0
  foreach ($k in (@($a.Keys) + @($b.Keys) | Sort-Object -Unique)) {
    if (-not $b.ContainsKey($k)) { Say "  НЕТ ПОСЛЕ ОТКАТА: $k  [$($a[$k])]" 'Red'; $n++ }
    elseif (-not $a.ContainsKey($k)) { Say "  ЛИШНЯЯ ПОСЛЕ ОТКАТА: $k  [$($b[$k])]" 'Red'; $n++ }
    elseif ($a[$k] -ne $b[$k]) { Say "  ОТЛИЧАЕТСЯ: $k" 'Red'; Say "     до:    $($a[$k])"; Say "     после: $($b[$k])"; $n++ }
  }
  Say ("  отличий: $n") $(if ($n) { 'Red' } else { 'Green' })
}
finally { $env:PGPASSWORD = $null }
$file = Join-Path $ReportDir 'diag.txt'
$out | Set-Content -Path $file -Encoding UTF8
Say "Записано: $file (без паролей, текстов и данных учеников). Пришлите Claude этот файл."
