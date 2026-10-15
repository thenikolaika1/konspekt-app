<#
  Konspekt by NK — применение пяти миграций Friends & Family строго по порядку.

  Что делает:
    1. Проверяет файлы миграций (SHA-256), psql и подключение.
    2. precheck.sql — база в ожидаемом состоянии (только чтение).
    3. status.sql — какие миграции уже применены; продолжает с первой неприменённой.
    4. Сохраняет число строк и отпечаток структуры ДО (только чтение).
    5. Каждую миграцию — отдельной транзакцией: psql --single-transaction -v ON_ERROR_STOP=1.
       Любая SQL-ошибка → транзакция откатывается целиком, следующие миграции не запускаются.
    6. postcheck.sql, число строк и отпечаток ПОСЛЕ; сравнение с ДО.
  Пароль спрашивается скрыто, хранится только в памяти этого окна и стирается в конце.
  Все результаты — в папке -OutDir (паролей там нет).

  Пример (production, Session pooler из Dashboard → Connect):
    .\apply-ff-migrations.ps1 -DbHost aws-0-XX.pooler.supabase.com -CheckOnly   # только проверки, без изменений
    .\apply-ff-migrations.ps1 -DbHost aws-0-XX.pooler.supabase.com              # применение
#>
param(
  [Parameter(Mandatory = $true)][string]$DbHost,
  [string]$DbUser = 'postgres.ohdeykbkgimvwstkwuuf',
  [int]$DbPort = 5432,
  [string]$DbName = 'postgres',
  [string]$SslMode = 'require',
  [string]$RepoDir = '',
  [string]$MigrationsDir = '',
  [string]$OutDir = '',
  [string]$PsqlPath = '',
  [switch]$CheckOnly,
  [switch]$NoPassword,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Migrations = @(
  '20261011120000_ff_ai_limits',
  '20261011120500_ff_invite_code_normalize',
  '20261011130000_analytics',
  '20261011130100_analytics_catalog',
  '20261011130200_analytics_reports'
)

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail([string]$text) { Say ''; Say ('СТОП: ' + $text) 'Red'; exit 1 }

# ---------- пути ----------
if (-not $RepoDir) { $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if (-not $MigrationsDir) { $MigrationsDir = Join-Path $RepoDir 'supabase\migrations' }
$CheckDir = $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path (Get-Location) ('ff-release-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not $PsqlPath) {
  $cmd = Get-Command psql -ErrorAction SilentlyContinue
  if ($cmd) { $PsqlPath = $cmd.Source }
  elseif (Test-Path 'C:\Program Files\PostgreSQL\17\bin\psql.exe') { $PsqlPath = 'C:\Program Files\PostgreSQL\17\bin\psql.exe' }
  else { Fail 'psql не найден. Укажите -PsqlPath "C:\Program Files\PostgreSQL\17\bin\psql.exe"' }
}

$verLine = (& $PsqlPath --version) | Select-Object -First 1
if ($verLine -notmatch '(\d+)\.') { Fail ('не удалось определить версию psql: ' + $verLine) }
if ([int]$Matches[1] -lt 15) { Fail ('нужен psql 15 или новее (лучше 17), найден: ' + $verLine) }
Say ('psql: ' + $verLine)

# ---------- файлы миграций ----------
$hashLog = @()
foreach ($m in $Migrations) {
  $f = Join-Path $MigrationsDir ($m + '.sql')
  if (-not (Test-Path $f)) { Fail ('нет файла миграции ' + $f) }
  $h = (Get-FileHash -Algorithm SHA256 -Path $f).Hash.ToLower()
  $hashLog += ($m + '.sql  ' + $h)
}
foreach ($c in 'precheck.sql', 'status.sql', 'counts.sql', 'fingerprint.sql', 'postcheck.sql') {
  if (-not (Test-Path (Join-Path $CheckDir $c))) { Fail ('нет файла проверки ' + $c) }
}
$hashLog | Set-Content -Encoding UTF8 (Join-Path $OutDir 'migrations-sha256.txt')
Say 'SHA-256 файлов миграций:'; $hashLog | ForEach-Object { Say ('  ' + $_) }

# ---------- подключение ----------
$env:PGHOST = $DbHost; $env:PGPORT = "$DbPort"; $env:PGUSER = $DbUser; $env:PGDATABASE = $DbName
$env:PGSSLMODE = $SslMode; $env:PGAPPNAME = 'konspekt-ff-release'; $env:PGCLIENTENCODING = 'UTF8'
if (-not $NoPassword) {
  $sec = Read-Host -AsSecureString ('Пароль базы для ' + $DbUser + ' (символы не отображаются)')
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Invoke-Psql([string[]]$PsqlArgs, [string]$LogName) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = & $PsqlPath -X -v ON_ERROR_STOP=1 @PsqlArgs 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($LogName) { $out | Set-Content -Encoding UTF8 (Join-Path $OutDir $LogName) }
  return @{ Code = $code; Out = @($out) }
}
function Run-Check([string]$File, [string]$LogName) { Invoke-Psql @('-At', '-F', '|', '-f', (Join-Path $CheckDir $File)) $LogName }

try {
  $r = Invoke-Psql @('-At', '-F', '|', '-c', "select current_user, current_database(), current_setting('server_version')") 'connection.txt'
  if ($r.Code -ne 0) { Fail ("нет подключения к базе:`n" + ($r.Out -join "`n")) }
  Say ('Подключение: ' + ($r.Out -join ' ')) 'Green'

  # ---------- состояние ДО ----------
  $r = Run-Check 'precheck.sql' 'precheck.txt'
  if ($r.Code -ne 0) { Fail ("precheck не пройден (ничего не изменено):`n" + ($r.Out -join "`n")) }
  Say 'PRECHECK OK' 'Green'

  $r = Run-Check 'status.sql' 'status-before.txt'
  if ($r.Code -ne 0) { Fail ("не удалось определить состояние миграций:`n" + ($r.Out -join "`n")) }
  $applied = @{}
  foreach ($line in $r.Out) { $p = $line.Split('|'); if ($p.Count -eq 2) { $applied[$p[0]] = ($p[1] -eq 't') } }
  $pending = @(); $seenPending = $false
  foreach ($m in $Migrations) {
    $v = $m.Substring(0, 14)
    if (-not $applied.ContainsKey($v)) { Fail ('нет статуса для ' + $v) }
    if ($applied[$v]) {
      if ($seenPending) { Fail ('неожиданное состояние: ' + $v + ' применена, а более ранняя — нет. Ничего не изменено.') }
      Say ('  уже применена: ' + $m)
    } else { $seenPending = $true; $pending += $m; Say ('  к применению:  ' + $m) 'Yellow' }
  }

  $r = Run-Check 'counts.sql' 'counts-before.txt'; if ($r.Code -ne 0) { Fail ("counts.sql:`n" + ($r.Out -join "`n")) }
  $countsBefore = @{}; foreach ($line in $r.Out) { $p = $line.Split('|'); if ($p.Count -eq 2) { $countsBefore[$p[0]] = [long]$p[1] } }
  $r = Run-Check 'fingerprint.sql' 'fingerprint-before.txt'; if ($r.Code -ne 0) { Fail ("fingerprint.sql:`n" + ($r.Out -join "`n")) }
  $fpBefore = $r.Out
  Say ('Число строк ДО сохранено (' + $countsBefore.Count + ' таблиц), отпечаток ДО сохранён: ' + $OutDir)

  if ($CheckOnly) { Say ''; Say 'Режим -CheckOnly: изменений не было.' 'Green'; exit 0 }

  # ---------- применение ----------
  if ($pending.Count -gt 0) {
    if (-not $Yes) {
      Say ''; Say ('Будут применены к ' + $DbHost + ' (' + $DbUser + '):') 'Yellow'
      $pending | ForEach-Object { Say ('  ' + $_) 'Yellow' }
      $answer = Read-Host 'Введите APPLY (заглавными) для применения, что угодно другое — отмена'
      if ($answer -cne 'APPLY') { Say 'Отменено. Изменений не было.' 'Green'; exit 0 }
    }
    $i = 0
    foreach ($m in $pending) {
      $i++
      Say ('[' + $i + '/' + $pending.Count + '] ' + $m + ' ...')
      $file = Join-Path $MigrationsDir ($m + '.sql')
      $r = Invoke-Psql @('--single-transaction', '-c', "set local lock_timeout = '10s'", '-f', $file) ('apply-' + $m + '.log')
      if ($r.Code -ne 0) {
        $err = $r.Out | Where-Object { $_ -match 'ERROR|ОШИБКА|FATAL' } | Select-Object -First 5
        Run-Check 'status.sql' 'status-after-failure.txt' | Out-Null
        Fail ("ошибка в " + $m + ". Транзакция откатилась: эта миграция НЕ применена, следующие не запускались.`n" + ($err -join "`n") + "`nПодробности: " + (Join-Path $OutDir ('apply-' + $m + '.log')))
      }
      Say ('      OK') 'Green'
    }
  } else { Say 'Все пять миграций уже применены — применять нечего.' 'Green' }

  # ---------- проверки ПОСЛЕ ----------
  $r = Run-Check 'status.sql' 'status-after.txt'
  if (@($r.Out | Where-Object { $_ -match '\|f$' }).Count -gt 0) { Fail ("после применения не все миграции на месте:`n" + ($r.Out -join "`n")) }
  $r = Run-Check 'postcheck.sql' 'postcheck.txt'
  if ($r.Code -ne 0) { Fail ("POSTCHECK не пройден:`n" + ($r.Out -join "`n")) }
  Say (($r.Out | Where-Object { $_ -match 'POSTCHECK OK' }) -replace '^.*NOTICE:\s*', '') 'Green'

  $r = Run-Check 'counts.sql' 'counts-after.txt'; if ($r.Code -ne 0) { Fail ("counts.sql:`n" + ($r.Out -join "`n")) }
  $bad = 0
  foreach ($line in $r.Out) {
    $p = $line.Split('|'); if ($p.Count -ne 2) { continue }
    $t = $p[0]; $after = [long]$p[1]
    if (-not $countsBefore.ContainsKey($t)) { continue }
    $before = $countsBefore[$t]
    if ($after -lt $before) { Say ('  ПОТЕРЯ: ' + $t + ' было ' + $before + ', стало ' + $after) 'Red'; $bad++ }
    elseif ($after -gt $before) { Say ('  больше: ' + $t + ' ' + $before + ' → ' + $after + ' (новые записи пользователей во время работы — это нормально)') 'Yellow' }
  }
  if ($bad -gt 0) { Fail ('число строк уменьшилось в ' + $bad + ' таблиц(ах) — см. counts-before.txt и counts-after.txt') }
  Say ('Число строк: потерь нет (' + $countsBefore.Count + ' таблиц).') 'Green'

  $r = Run-Check 'fingerprint.sql' 'fingerprint-after.txt'; if ($r.Code -ne 0) { Fail ("fingerprint.sql:`n" + ($r.Out -join "`n")) }
  $diff = Compare-Object -ReferenceObject $fpBefore -DifferenceObject $r.Out
  if ($diff) { Fail ("структура существующих таблиц изменилась:`n" + (($diff | ForEach-Object { $_.SideIndicator + ' ' + $_.InputObject }) -join "`n")) }
  Say 'Структура существующих таблиц, права и политики: без изменений.' 'Green'

  Say ''; Say ('ГОТОВО. Все результаты: ' + $OutDir) 'Green'
  exit 0
}
finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
