<#
  Konspekt by NK — подготовка аккаунтов участников Friends & Family (вход по ID и ключу).

  Что делает:
    1. Генерирует для каждого участника ID (KN-XXXXXX) и отдельный ключ (20 символов) криптографически
       стойким генератором (RandomNumberGenerator, без смещения). Алфавит без неоднозначных символов:
       нет O, I, L, 0, 1.
    2. Создаёт пользователя в Supabase Auth (Admin API, email подтверждён):
       email id-kn-xxxxxx@id.konspekt.invalid, пароль Kn-2.<ключ> — так же, как вход в приложении (js/cloud.js).
    3. Записывает ID и ключи в CSV ВНЕ репозитория (файл не перезаписывается; строка — сразу после создания аккаунта).
    4. Готовит entitlements.sql: каждому участнику source = 'beta_invite', quota = 1, plan = 'beta'.
       SQL сам проверяет результат (а не успешность вызова) и откатывается при любом расхождении.
       verify.sql — повторная проверка (только чтение).

  Ключ service_role: из переменной окружения KONSPEKT_SERVICE_ROLE_KEY или скрытым вводом.
  Он хранится только в памяти этого окна, не пишется в файлы и на экран. Ключи участников на экран не выводятся.

  Пример:
    .\ff-accounts.ps1 -Count 12 -OutDir C:\Users\me\Documents\ff-accounts
  После этого: выполнить <OutDir>\entitlements.sql (SQL Editor или psql), затем verify.sql.
#>
param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 30)][int]$Count,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$SupabaseUrl = 'https://ohdeykbkgimvwstkwuuf.supabase.co',
  [string]$RepoDir = '',
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail([string]$text) { Say ''; Say ('СТОП: ' + $text) 'Red'; exit 1 }

$Alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'   # 31 символ; тот же, что ID_ALPHABET в js/cloud.js
$IdLen = 6
$KeyLen = 20
$Domain = '@id.konspekt.invalid'
$PasswordPrefix = 'Kn-2.'

# ---------- папка результатов: только вне репозитория ----------
if (-not $RepoDir) { $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$repoFull = [System.IO.Path]::GetFullPath($RepoDir).TrimEnd('\', '/')
$outFull = [System.IO.Path]::GetFullPath($OutDir).TrimEnd('\', '/')
$sep = [System.IO.Path]::DirectorySeparatorChar
if ($outFull -eq $repoFull -or $outFull.StartsWith($repoFull + $sep, [StringComparison]::OrdinalIgnoreCase)) {
  Fail 'папка -OutDir внутри репозитория. Ключи участников не должны попасть в git — укажите папку вне репозитория.'
}
New-Item -ItemType Directory -Force -Path $outFull | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$csvPath = Join-Path $outFull ('ff-accounts-' + $stamp + '.csv')
$sqlPath = Join-Path $outFull ('entitlements-' + $stamp + '.sql')
$verifyPath = Join-Path $outFull ('verify-' + $stamp + '.sql')
foreach ($p in @($csvPath, $sqlPath, $verifyPath)) { if (Test-Path $p) { Fail ('файл уже существует: ' + $p) } }

$baseUri = $SupabaseUrl.TrimEnd('/')
if ($baseUri -notmatch '^https?://') { Fail 'SupabaseUrl должен начинаться с https://' }

# ---------- генератор ----------
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function New-Secret([int]$len) {
  # отбрасываем байты >= 248 (248 = 31 * 8): каждый символ алфавита равновероятен
  $chars = New-Object System.Text.StringBuilder
  $buf = New-Object byte[] 64
  while ($chars.Length -lt $len) {
    $rng.GetBytes($buf)
    foreach ($b in $buf) {
      if ($b -lt 248 -and $chars.Length -lt $len) { [void]$chars.Append($Alphabet[$b % 31]) }
    }
  }
  return $chars.ToString()
}
function Format-Key([string]$k) { return ($k.Substring(0, 5) + '-' + $k.Substring(5, 5) + '-' + $k.Substring(10, 5) + '-' + $k.Substring(15, 5)) }

# ---------- ключ service_role ----------
$serviceKey = $env:KONSPEKT_SERVICE_ROLE_KEY
if (-not $serviceKey) {
  $sec = Read-Host -AsSecureString 'Ключ service_role (ввод скрыт)'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $serviceKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $serviceKey -or $serviceKey.Length -lt 20) { Fail 'ключ service_role не задан' }
$headers = @{ apikey = $serviceKey; Authorization = ('Bearer ' + $serviceKey) }

Say ('Проект: ' + $baseUri)
Say ('Будет создано аккаунтов: ' + $Count)
Say ('ID и ключи: ' + $csvPath)
if (-not $Yes) {
  $ans = Read-Host 'Создать аккаунты? Введите YES'
  if ($ans -cne 'YES') { Fail 'отменено' }
}

# заголовок CSV; дальше — по строке сразу после каждого созданного аккаунта (сбой посередине ничего не теряет)
[System.IO.File]::WriteAllText($csvPath, "id,key,uid`r`n", (New-Object System.Text.UTF8Encoding($true)))

function Invoke-Admin([string]$method, [string]$path, $body) {
  $json = if ($null -ne $body) { $body | ConvertTo-Json -Depth 5 -Compress } else { $null }
  try {
    $r = Invoke-WebRequest -Method $method -Uri ($baseUri + $path) -Headers $headers -ContentType 'application/json' -Body $json -UseBasicParsing
    return @{ status = [int]$r.StatusCode; body = ($r.Content | ConvertFrom-Json) }
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { throw ('нет ответа сервера: ' + $_.Exception.Message) }
    $text = ''
    try { $text = $_.ErrorDetails.Message } catch { }
    return @{ status = [int]$resp.StatusCode; body = $null; error = $text }
  }
}

$created = @()
try {
  for ($i = 1; $i -le $Count; $i++) {
    $done = $false
    for ($try = 1; $try -le 5 -and -not $done; $try++) {
      $id = 'KN-' + (New-Secret $IdLen)
      $key = New-Secret $KeyLen
      $email = 'id-' + $id.ToLowerInvariant() + $Domain
      $res = Invoke-Admin 'POST' '/auth/v1/admin/users' @{
        email = $email; password = ($PasswordPrefix + $key); email_confirm = $true; user_metadata = @{ kn_id = $id }
      }
      if ($res.status -eq 200 -or $res.status -eq 201) {
        $uid = [string]$res.body.id
        if ($uid -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { Fail ('сервер не вернул id пользователя для ' + $id) }
        if ([string]$res.body.email -ne $email) { Fail ('сервер вернул другой email для ' + $id) }
        [System.IO.File]::AppendAllText($csvPath, ($id + ',' + (Format-Key $key) + ',' + $uid + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
        $created += [pscustomobject]@{ id = $id; uid = $uid }
        Say ('  ' + $i + '/' + $Count + '  ' + $id + '  создан') 'Green'
        $done = $true
      } elseif ($res.status -eq 422 -and $res.error -match 'email_exists|already') {
        Say ('  ' + $id + ' уже занят — другой ID') 'Yellow'   # совпадение ID: генерируем новый
      } else {
        Fail ('Admin API ответил ' + $res.status + ' (' + ($res.error -replace '[\r\n]+', ' ') + ')')
      }
      $key = $null
    }
    if (-not $done) { Fail 'не удалось подобрать свободный ID за 5 попыток' }
  }
} finally {
  $serviceKey = $null; $headers = $null; $key = $null
  $rng.Dispose()
}

if (-not $created.Count) { Fail 'ни одного аккаунта не создано' }

# ---------- SQL: права участников, с проверкой результата ----------
$values = ($created | ForEach-Object { "('" + $_.uid + "'::uuid, '" + $_.id + "')" }) -join ",`n    "
$n = $created.Count
$sql = @"
-- Konspekt F&F: права участников (вход по ID). Создано ff-accounts.ps1 $stamp. Секретов здесь нет.
-- Каждому: resource text_generation, plan beta, quota 1, source beta_invite.
-- private.admin_set_entitlement при существующей строке НЕ меняет source, поэтому:
--   до вызова — у этих пользователей не должно быть прав; после — проверяется каждая строка.
-- Любое расхождение → exception → вся транзакция откатывается.
begin;
do `$`$
declare
  v_ids uuid[];
  v_n int;
begin
  create temp table ff_new (user_id uuid primary key, kn_id text not null) on commit drop;
  insert into ff_new values
    $values;
  select array_agg(user_id) into v_ids from ff_new;

  select count(*) into v_n from auth.users u join ff_new f on f.user_id = u.id
   where u.email = 'id-' || lower(f.kn_id) || '@id.konspekt.invalid' and u.email_confirmed_at is not null;
  if v_n <> $n then raise exception 'auth.users: найдено % из $n подтверждённых аккаунтов', v_n; end if;

  select count(*) into v_n from private.user_entitlements where user_id = any(v_ids);
  if v_n <> 0 then raise exception 'у % пользователей уже есть права — source не будет изменён, проверьте вручную', v_n; end if;

  perform private.admin_set_entitlement(f.user_id, 1, 'beta', 'beta_invite') from ff_new f;

  select count(*) into v_n from private.user_entitlements e join ff_new f on f.user_id = e.user_id
   where e.resource = 'text_generation' and e.plan = 'beta' and e.quota = 1 and e.source = 'beta_invite';
  if v_n <> $n then raise exception 'права: верных строк % из $n', v_n; end if;

  select count(*) into v_n from private.user_entitlements where user_id = any(v_ids);
  if v_n <> $n then raise exception 'права: всего строк % вместо $n', v_n; end if;

  raise notice 'OK: % участникам назначено beta_invite, quota 1', v_n;
end
`$`$;
commit;
"@
[System.IO.File]::WriteAllText($sqlPath, $sql, (New-Object System.Text.UTF8Encoding($false)))

$uidList = ($created | ForEach-Object { "'" + $_.uid + "'" }) -join ', '
$verify = @"
-- Konspekt F&F: проверка участников (только чтение). Ожидается $n строк, у всех ok = true.
select f.kn_id, u.id as user_id, u.email_confirmed_at is not null as confirmed,
       e.plan, e.quota, e.source,
       (e.plan = 'beta' and e.quota = 1 and e.source = 'beta_invite' and u.email_confirmed_at is not null) as ok
  from (select u.id, upper(substr(split_part(u.email, '@', 1), 4)) as kn_id from auth.users u where u.id in ($uidList)) f
  join auth.users u on u.id = f.id
  left join private.user_entitlements e on e.user_id = u.id and e.resource = 'text_generation'
 order by f.kn_id;
"@
[System.IO.File]::WriteAllText($verifyPath, $verify, (New-Object System.Text.UTF8Encoding($false)))

Say ''
Say ('Создано аккаунтов: ' + $n) 'Green'
Say ('ID и ключи (секрет, не публиковать): ' + $csvPath)
Say ('Дальше: выполнить ' + $sqlPath + ' (должно быть «OK: ' + $n + ' …»), затем ' + $verifyPath)
Say 'Пока entitlements.sql не выполнен, участники входят, но создавать конспекты не могут.' 'Yellow'
