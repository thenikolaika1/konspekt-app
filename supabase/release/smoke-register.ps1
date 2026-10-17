<#
  Konspekt by NK — пробная регистрация v58 по одноразовому коду (метка smoke) без сайта.

  Проходит путь ученика через production: register-invite создаёт аккаунт по коду → вход по ID и ключу →
  право beta_invite (quota 1). Плюс отказы: пустой запрос, неверный код, повтор кода с другим ID,
  неверный ключ, обычная регистрация технического email (хук → 403).

  Код вводится скрыто (в чат его не присылать). ID и ключ генерируются здесь так же, как в приложении.
  Ключ на экран не выводится и никуда не сохраняется; ID печатается — по нему тестовый аккаунт потом удаляется.
  AI не вызывается, данные других пользователей не затрагиваются.

  Запуск (PowerShell, в папке репозитория):
    powershell -ExecutionPolicy Bypass -File .\supabase\release\smoke-register.ps1
#>
param(
  [string]$ProjectUrl = 'https://ohdeykbkgimvwstkwuuf.supabase.co',
  [string]$FunctionUrl = '',
  [string]$ApiKey = '',
  [string]$Code = '',
  # код уже погашен этим тестом: только проверки без регистрации (пустой запрос, неверный код, USED, хук)
  [switch]$AfterUse
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
function Say([string]$t, [string]$c = 'Gray') { Write-Host $t -ForegroundColor $c }

if (-not $FunctionUrl) { $FunctionUrl = "$ProjectUrl/functions/v1/register-invite" }
if (-not $ApiKey) {
  $cfg = Join-Path $PSScriptRoot '..\..\js\config.js'
  $m = Select-String -Path $cfg -Pattern 'sb_publishable_[A-Za-z0-9_-]+' -ErrorAction SilentlyContinue
  if (-not $m) { Say 'СТОП: не найден publishable key в js\config.js' 'Red'; exit 1 }
  $ApiKey = $m.Matches[0].Value
}
if (-not $Code) {
  $sec = Read-Host -AsSecureString 'Код приглашения smoke (ввод скрыт)'
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $Code = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
$Code = $Code.Trim()
if (-not $Code) { Say 'СТОП: код не введён' 'Red'; exit 1 }

# ID и ключ — как в приложении (js/cloud.js): алфавит без похожих символов, криптографический генератор
$ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function RandStr([int]$n) {
  $buf = New-Object byte[] 1; $s = ''
  while ($s.Length -lt $n) { $rng.GetBytes($buf); if ($buf[0] -lt 248) { $s += $ALPHA[$buf[0] % 31] } }
  return $s
}
$id = 'KN-' + (RandStr 6); $key = RandStr 20; $id2 = 'KN-' + (RandStr 6)
$email = 'id-' + $id.ToLower() + '@id.konspekt.invalid'
$password = 'Kn-2.' + $key

# HTTP через HttpClient: тело ответа читается одинаково для 2xx и 4xx в Windows PowerShell 5.1 и PowerShell 7
# (Invoke-WebRequest в 5.1 при ошибке HTTP не отдаёт тело ответа — проверки видели только код статуса)
Add-Type -AssemblyName System.Net.Http
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$http = [System.Net.Http.HttpClient]::new()
$http.Timeout = [TimeSpan]::FromSeconds(30)
function Call([string]$method, [string]$url, $body, [hashtable]$headers = @{}) {
  $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($method), $url)
  foreach ($k in $headers.Keys) { [void]$req.Headers.TryAddWithoutValidation($k, [string]$headers[$k]) }
  $json = if ($null -eq $body) { '{}' } else { $body | ConvertTo-Json -Compress }
  $req.Content = [System.Net.Http.StringContent]::new($json, [System.Text.Encoding]::UTF8, 'application/json')
  try {
    $res = $http.SendAsync($req).GetAwaiter().GetResult()
    $txt = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $j = $null; try { $j = $txt | ConvertFrom-Json } catch { }
    return @{ s = [int]$res.StatusCode; j = $j }
  } catch {
    return @{ s = 0; j = $null }
  }
}
$pass = 0; $fail = 0
function Check([bool]$ok, [string]$name, [string]$got) {
  if ($ok) { $script:pass++; Say ("  OK    " + $name) 'Green' } else { $script:fail++; Say ("  FAIL  " + $name + "  (получено: " + $got + ")") 'Red' }
}
$fn = @{}; $auth = @{ apikey = $ApiKey }
$err = { param($r) "$($r.s) $(if ($r.j) { $r.j | ConvertTo-Json -Compress } else { '' })" }

if (-not $AfterUse) { Say ("Тестовый ID: " + $id + "   (ключ не показывается)") }
# 1. отказы без траты кода
$r = Call POST $FunctionUrl @{} $fn
Check ($r.s -eq 400 -and $r.j.error -eq 'BAD_REQUEST') 'пустой запрос → BAD_REQUEST' (& $err $r)
$r = Call POST $FunctionUrl @{ code = ('ZZZZ-' + (RandStr 4) + '-' + (RandStr 4)); id = $id; key = $key } $fn
Check ($r.s -eq 400 -and $r.j.error -eq 'INVALID') 'неверный код → INVALID' (& $err $r)
if ($AfterUse) {
  # код уже погашен: другой ID → USED (новый аккаунт не создаётся), обычная регистрация → отказ хука
  $r = Call POST $FunctionUrl @{ code = $Code; id = $id2; key = $key } $fn
  Check ($r.s -eq 409 -and $r.j.error -eq 'USED') 'погашенный код с другим ID → USED' (& $err $r)
  $r = Call POST "$ProjectUrl/auth/v1/signup" @{ email = ('id-' + $id2.ToLower() + '@id.konspekt.invalid'); password = ('Kn-2.' + (RandStr 20)) } $auth
  Check ($r.s -eq 403 -or $r.s -eq 400 -or $r.s -eq 422) 'обычная регистрация технического email → отказ' (& $err $r)
  $key = $null; $password = $null
  Say ''
  if ($fail -eq 0) { Say ("ПРОВЕРКА ОТКАЗОВ OK: $pass из $pass (регистрация не выполнялась)") 'Green' }
  else { Say ("ПРОВЕРКА ОТКАЗОВ: ошибок $fail из $($pass + $fail). Пришлите строки FAIL (без кода).") 'Red'; exit 1 }
  exit 0
}
# 2. регистрация по коду
$r = Call POST $FunctionUrl @{ code = $Code; id = $id; key = $key } $fn
$registered = ($r.s -eq 200 -and $r.j.status -eq 'ok' -and $r.j.id -eq $id)
Check $registered 'регистрация по коду → ok' (& $err $r)
if (-not $registered) {
  Say ''
  Say 'СТОП: регистрация не прошла — дальше не проверяем. Пришлите строки выше (без кода).' 'Red'
  exit 1
}
$r = Call POST $FunctionUrl @{ code = $Code; id = $id; key = $key } $fn
Check ($r.s -eq 200 -and $r.j.status -eq 'ok') 'повтор того же запроса (потерянный ответ) → ok, второй аккаунт не создан' (& $err $r)
$r = Call POST $FunctionUrl @{ code = $Code; id = $id2; key = $key } $fn
Check ($r.s -eq 409 -and $r.j.error -eq 'USED') 'тот же код с другим ID → USED' (& $err $r)
# 3. вход по ID и ключу
$r = Call POST "$ProjectUrl/auth/v1/token?grant_type=password" @{ email = $email; password = $password } $auth
$token = if ($r.s -eq 200) { $r.j.access_token } else { $null }
Check ([bool]$token -and $r.j.user.email -eq $email -and -not $r.j.user.is_anonymous) 'вход по ID и ключу → сессия' ("$($r.s)")
$r = Call POST "$ProjectUrl/auth/v1/token?grant_type=password" @{ email = $email; password = ('Kn-2.' + (RandStr 20)) } $auth
Check ($r.s -eq 400) 'вход с неверным ключом → отказ' ("$($r.s)")
# 4. право на AI: beta_invite, quota 1
if ($token) {
  $r = Call POST "$ProjectUrl/rest/v1/rpc/get_my_access" @{} @{ apikey = $ApiKey; Authorization = "Bearer $token" }
  $row = @($r.j) | Where-Object { $_.resource -eq 'text_generation' } | Select-Object -First 1
  Check ($r.s -eq 200 -and $row -and $row.quota -eq 1 -and $row.used -eq 0) 'право text_generation: quota 1, использовано 0' (& $err $r)
}
# 5. хук: обычная регистрация технического email запрещена
$r = Call POST "$ProjectUrl/auth/v1/signup" @{ email = ('id-' + $id2.ToLower() + '@id.konspekt.invalid'); password = ('Kn-2.' + (RandStr 20)) } $auth
Check ($r.s -eq 403 -or $r.s -eq 400 -or $r.s -eq 422) 'обычная регистрация технического email → отказ' ("$($r.s)")
$key = $null; $password = $null

Say ''
if ($fail -eq 0) { Say ("SMOKE OK: $pass из $pass. Тестовый ID: $id — пришлите его, тестовый аккаунт будет удалён.") 'Green' }
else { Say ("SMOKE: ошибок $fail из $($pass + $fail). Тестовый ID: $id. Пришлите строки FAIL (без кода).") 'Red'; exit 1 }
