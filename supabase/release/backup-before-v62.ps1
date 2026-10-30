<#
  Konspekt by NK — резервная копия production перед выпуском v62 (копия backup-before-v58.ps1 с таблицами v61–v62) (Supabase Free: автоматических копий нет).

  Делает две копии и проверяет, что они полные и читаются:
    1. konspekt-full.dump — вся база (схемы, функции, RLS, данные, включая auth и storage-метаданные);
    2. konspekt-data.dump — данные приложения и пользователей: public.*, private.*, analytics.*, auth.users, auth.identities.
  Проверка: число строк в копии (по COPY-блокам) = число строк в базе для пользователей, конспектов, прав, журнала
  квот, генераций и аналитики. Плюс SHA-256 файлов.

  Нужны только PostgreSQL 17 Command Line Tools (pg_dump, pg_restore, psql) — уже установлены для миграций F&F.
  Пароль базы вводится скрыто, хранится только в памяти этого окна и стирается в конце. Ничего не изменяет в базе.

  Запуск (PowerShell, в папке репозитория):
    powershell -ExecutionPolicy Bypass -File .\supabase\release\backup-before-v62.ps1 -DbHost aws-0-XX.pooler.supabase.com
  Host — Dashboard → Connect → Session pooler (часть после @ и до :5432).
#>
param(
  [Parameter(Mandatory = $true)][string]$DbHost,
  [string]$DbUser = 'postgres.ohdeykbkgimvwstkwuuf',
  [int]$DbPort = 5432,
  [string]$DbName = 'postgres',
  [string]$SslMode = 'require',
  [string]$OutDir = '',
  [string]$PgBin = '',
  [int]$MinPgMajor = 17
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
function Say([string]$t, [string]$c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Fail([string]$t) { Say ''; Say ('СТОП: ' + $t) 'Red'; exit 1 }

# ---------- инструменты PostgreSQL ----------
function Find-Tool([string]$name) {
  if ($PgBin) { $p = Join-Path $PgBin $name; if (Test-Path $p) { return $p }; if (Test-Path ($p + '.exe')) { return $p + '.exe' } }
  foreach ($v in 18, 17) { $p = "C:\Program Files\PostgreSQL\$v\bin\$name.exe"; if (Test-Path $p) { return $p } }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}
$pgDump = Find-Tool 'pg_dump'; $pgRestore = Find-Tool 'pg_restore'; $psql = Find-Tool 'psql'
if (-not $pgDump -or -not $pgRestore -or -not $psql) { Fail 'не найдены pg_dump / pg_restore / psql. Укажите -PgBin "C:\Program Files\PostgreSQL\17\bin"' }
$ver = (& $pgDump --version) -replace '.*\s(\d+)(\.\d+)*.*', '$1'
if ([int]$ver -lt $MinPgMajor) { Fail ("pg_dump версии $ver; нужна $MinPgMajor или новее (в Supabase PostgreSQL 17). Установите PostgreSQL 17 Command Line Tools.") }
Say ("pg_dump: " + (& $pgDump --version))

# ---------- папка ----------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $OutDir) { $OutDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) ('konspekt-backup-' + $stamp) }
if (Test-Path (Join-Path $OutDir 'konspekt-full.dump')) { Fail ('в папке уже есть копия: ' + $OutDir) }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$full = Join-Path $OutDir 'konspekt-full.dump'
$data = Join-Path $OutDir 'konspekt-data.dump'

# ---------- подключение (пароль — скрыто, только в памяти) ----------
$env:PGHOST = $DbHost; $env:PGPORT = "$DbPort"; $env:PGUSER = $DbUser; $env:PGDATABASE = $DbName; $env:PGSSLMODE = $SslMode
if (-not $env:PGPASSWORD) {
  $sec = Read-Host -AsSecureString 'Пароль базы (ввод скрыт)'
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$tables = @('auth.users', 'auth.identities', 'public.notes', 'public.ai_generations', 'private.user_entitlements',
            'private.usage_ledger', 'private.beta_invites', 'private.ai_limits', 'analytics.app_events', 'analytics.paragraph_views',
            'private.access_grants', 'private.access_log', 'private.generation_starts', 'private.access_settings', 'private.plans',
            'private.owner_panel_secrets', 'private.owner_requests', 'private.invite_meta')
try {
  # 1. число строк в базе (только чтение) — до и после копирования
  $q = ($tables | ForEach-Object { "select '$_', count(*) from $_" }) -join ' union all '
  function Live-Counts {
    $r = @{}
    & $psql -X -w -A -t -F '|' -v ON_ERROR_STOP=1 -c $q | ForEach-Object { if ($_ -match '^(.+)\|(\d+)$') { $r[$Matches[1]] = [int]$Matches[2] } }
    if ($LASTEXITCODE -ne 0 -or $r.Count -ne $tables.Count) { Fail 'не удалось подключиться к базе или прочитать таблицы (проверьте host и пароль)' }
    return $r
  }
  $live = Live-Counts
  Say ('Подключение есть. Пользователей: ' + $live['auth.users'] + ', конспектов: ' + $live['public.notes'])
  # структура приложения в базе: функции (без функций расширений), политики RLS, таблицы с включённым RLS
  $qs = "select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private','analytics') and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')) || '|' || (select count(*) from pg_policies where schemaname in ('public','private','analytics')) || '|' || (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relrowsecurity and c.relkind in ('r','p') and n.nspname in ('public','private','analytics'))"
  $struct = (& $psql -X -w -A -t -v ON_ERROR_STOP=1 -c $qs | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $struct -notmatch '^\d+\|\d+\|\d+$') { Fail 'не удалось прочитать структуру базы' }
  $liveF, $livePol, $liveRls = $struct.Split('|') | ForEach-Object { [int]$_ }

  # 2. копии
  Say 'Полная копия…'
  & $pgDump -w -Fc -f $full
  if ($LASTEXITCODE -ne 0) { Fail 'pg_dump (полная копия) завершился с ошибкой' }
  Say 'Копия данных приложения…'
  & $pgDump -w -Fc --data-only -t 'public.*' -t 'private.*' -t 'analytics.*' -t auth.users -t auth.identities -f $data
  if ($LASTEXITCODE -ne 0) { Fail 'pg_dump (копия данных) завершился с ошибкой' }
  $after = Live-Counts
} finally {
  $env:PGPASSWORD = $null; Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

# 3. проверка: файлы читаются, число строк в копии = в базе
# (если во время копирования кто-то пользовался приложением, число в копии — между «до» и «после»)
function Count-Rows([string]$dump) {
  $sql = & $pgRestore -f - $dump
  if ($LASTEXITCODE -ne 0) { Fail ('pg_restore не читает ' + $dump) }
  $counts = @{}; $cur = $null; $n = 0
  foreach ($line in $sql) {
    if ($line -match '^COPY ([\w"]+)\.([\w"]+) ') { $cur = ($Matches[1] + '.' + $Matches[2]).Replace('"', ''); $n = 0; continue }
    if ($cur) { if ($line -eq '\.') { $counts[$cur] = $n; $cur = $null } else { $n++ } }
  }
  return $counts
}
$ok = $true; $inCopy = @{}
foreach ($dump in @($full, $data)) {
  $c = Count-Rows $dump
  foreach ($t in $tables) {
    $have = if ($c.ContainsKey($t)) { $c[$t] } else { 0 }
    if ($dump -eq $data) { $inCopy[$t] = $have }
    $lo = [Math]::Min($live[$t], $after[$t]); $hi = [Math]::Max($live[$t], $after[$t])
    if ($have -lt $lo -or $have -gt $hi) { $ok = $false; Say ("  РАСХОЖДЕНИЕ " + (Split-Path $dump -Leaf) + ": $t — в копии $have, в базе " + $live[$t]) 'Red' }
  }
}
$toc = & $pgRestore -l $full
if ($LASTEXITCODE -ne 0) { Fail ('pg_restore не читает оглавление ' + $full) }
$listFull = ($toc | Measure-Object -Line).Lines
# 4. структура в полной копии = в базе: функции, политики, RLS; права (ACL) на функции и таблицы приложения на месте
$tocF = @($toc | Where-Object { $_ -match '^\d+; \d+ \d+ FUNCTION (public|private|analytics) ' }).Count
$tocPol = @($toc | Where-Object { $_ -match '^\d+; \d+ \d+ POLICY (public|private|analytics) ' }).Count
$tocRls = @($toc | Where-Object { $_ -match '^\d+; \d+ \d+ ROW SECURITY (public|private|analytics) ' }).Count
$tocAcl = @($toc | Where-Object { $_ -match '^\d+; \d+ \d+ ACL (public|private|analytics) ' }).Count
Say ("Структура: функций $tocF из $liveF, политик RLS $tocPol из $livePol, таблиц с RLS $tocRls из $liveRls, записей прав $tocAcl")
if ($tocF -ne $liveF -or $tocPol -ne $livePol -or $tocRls -ne $liveRls) { $ok = $false; Say '  РАСХОЖДЕНИЕ структуры: в копии не все функции, политики или RLS' 'Red' }
foreach ($need in @('TABLE DATA private access_grants', 'TABLE DATA private ai_limits', 'TABLE DATA private access_settings', 'TABLE DATA public notes',
                    'TABLE DATA auth users', 'ACL public FUNCTION get_my_access_v2()', 'ACL public TABLE notes', 'POLICY public notes notes: select own')) {
  if (-not ($toc | Where-Object { $_ -match ('^\d+; \d+ \d+ ' + [regex]::Escape($need) + ' ') })) { $ok = $false; Say ("  НЕТ В КОПИИ: " + $need) 'Red' }
}
if (-not $ok) { Fail 'копия неполная — выпуск не начинать, сообщите о проблеме' }
$busy = @($tables | Where-Object { $live[$_] -ne $after[$_] })
if ($busy.Count) { Say ('Во время копирования менялись: ' + ($busy -join ', ') + ' — копия согласована, это нормально.') 'Yellow' }

$h1 = (Get-FileHash $full -Algorithm SHA256).Hash; $h2 = (Get-FileHash $data -Algorithm SHA256).Hash
$sum = @(
  "Konspekt — резервная копия перед v62, $stamp",
  "konspekt-full.dump  $((Get-Item $full).Length) байт  SHA256 $h1  (объектов: $listFull)",
  "konspekt-data.dump  $((Get-Item $data).Length) байт  SHA256 $h2",
  ('Строк в копии: ' + (($tables | ForEach-Object { "$_ $($inCopy[$_])" }) -join ', ')),
  "Структура в копии: функций $tocF, политик RLS $tocPol, таблиц с RLS $tocRls, записей прав $tocAcl (как в базе)",
  'Хранить вне репозитория, не пересылать: в копии данные пользователей. Вторую копию папки — на флешку или в личное облако.',
  'Проверка копии на своём компьютере: pg_restore -d <пустая база PostgreSQL 17> konspekt-full.dump (с правами и RLS); в production не восстанавливать без решения владельца',
  'Точечное восстановление данных одной таблицы: pg_restore --data-only -n <схема> -t <таблица> -d <база> konspekt-data.dump (в очищенную таблицу)'
)
$sum | Set-Content -Path (Join-Path $OutDir 'README.txt') -Encoding UTF8
Say ''
Say 'КОПИЯ ГОТОВА И ПРОВЕРЕНА' 'Green'
$sum | ForEach-Object { Say $_ }
Say ('Папка: ' + $OutDir)
