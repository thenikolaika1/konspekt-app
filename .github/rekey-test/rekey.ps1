& {
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = 'https://ohdeykbkgimvwstkwuuf.supabase.co'
$uid  = 'c7b537ae-8fbb-4c9a-a047-26c8ccda1cfe'
$mail = 'id-kn-ek83ff@id.konspekt.invalid'
$pub  = 'sb_publishable_7t0cfHxy6z5QU4N1qW-4Og_6qcPhaQ_'
function Code($e) { try { $c = [int]$e.Exception.Response.StatusCode; if ($c) { $c } else { 0 } } catch { 0 } }
function Say($t, $c) { Write-Host $t -ForegroundColor $c }

$ss = Read-Host 'Секретный ключ проекта (при вводе не виден)' -AsSecureString
$s = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))
if (-not $s) { Say 'СТОП: секретный ключ не введён. Ничего не изменено.' Red; return }
$h = @{ apikey = $s }
if ($s.StartsWith('eyJ')) { $h['Authorization'] = "Bearer $s" }

# Шаг 1. Проверяем, что это именно KN-EK83FF
try { $u = Invoke-RestMethod -Method Get -Uri "$base/auth/v1/admin/users/$uid" -Headers $h -TimeoutSec 60 }
catch { Say "СТОП на шаге 1: ответ $(Code $_). Ничего не изменено." Red; return }
if ($u.id -ne $uid -or $u.email -ne $mail) { Say 'СТОП: найден не тот аккаунт. Ничего не изменено.' Red; return }
Say 'Шаг 1: аккаунт KN-EK83FF найден' Green

# Шаг 2. Новый ключ в формате приложения: 20 символов из алфавита приложения
# (31 символ: латиница без I, L, O и цифры 2-9). Равномерно: байты >= 256 - (256 mod 31) = 248 отбрасываются.
$a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
$n = $a.Length; $lim = 256 - (256 % $n)
$rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $b = New-Object byte[] 1; $k = ''
while ($k.Length -lt 20) { $rng.GetBytes($b); if ($b[0] -lt $lim) { $k += $a[$b[0] % $n] } }
if ($n -ne 31 -or $k -cnotmatch '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{20}$') { Say 'СТОП: ошибка генерации ключа. Ничего не изменено.' Red; return }
$show = ($k -split '(.{5})' | Where-Object { $_ }) -join '-'

# Шаг 3. Меняем только пароль. С момента отправки ключ уже не теряется: он будет показан при любом исходе,
# кроме явного отказа сервера (4xx), когда пароль точно не изменён.
$state = 'unknown'; $sent = $false; $done = $false
try {
  $body = @{ password = "Kn-2.$k" } | ConvertTo-Json
  $sent = $true
  try {
    $r = Invoke-RestMethod -Method Put -Uri "$base/auth/v1/admin/users/$uid" -Headers $h -ContentType 'application/json' -Body $body -TimeoutSec 60
    if ($r.id -eq $uid -and $r.email -eq $mail) { $state = 'changed' }
  } catch {
    $c = Code $_
    if ($c -ge 400 -and $c -lt 500) {
      $done = $true
      Say "СТОП на шаге 3: сервер отказал (ответ $c). Пароль НЕ изменён, ключ не показан." Red; return
    }
  }
  if ($state -eq 'changed') { Say 'Шаг 3: пароль обновлён' Green }
  else { Say 'Шаг 3: ответ сервера неясен - проверяю входом, изменился ли пароль' Yellow }

  # Шаг 4. Проверяем вход новым ключом так же, как приложение, и сразу выходим
  $login = 'error'; $lc = 0
  try {
    $lb = @{ email = $mail; password = "Kn-2.$k" } | ConvertTo-Json
    $t = Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{ apikey = $pub } -ContentType 'application/json' -Body $lb -TimeoutSec 60
    if ($t.user.id -eq $uid) { $login = 'ok' }
    try { Invoke-RestMethod -Method Post -Uri "$base/auth/v1/logout?scope=local" -Headers @{ apikey = $pub; Authorization = "Bearer $($t.access_token)" } -TimeoutSec 30 | Out-Null } catch {}
  } catch { $lc = Code $_; if ($lc -eq 400) { $login = 'rejected' } }

  Write-Host ''
  if ($login -eq 'ok') {
    Say 'Шаг 4: вход новым ключом проверен' Green
    Say "ГОТОВО. ID: KN-EK83FF   НОВЫЙ КЛЮЧ: $show" Yellow
    Say 'Перепишите ключ на бумагу и закройте окно PowerShell. Скрипт больше не запускайте.' White
  } elseif ($login -eq 'rejected' -and $state -eq 'unknown') {
    Say 'Пароль НЕ изменён: сервер не принял новый ключ. Ключ не показан. Скрипт можно запустить ещё раз.' Red
  } elseif ($state -eq 'changed') {
    Say "ВНИМАНИЕ: пароль ИЗМЕНЁН, но проверить вход не удалось (ответ $lc)." Red
    Say "ДЕЙСТВУЮЩИЙ КЛЮЧ: $show" Yellow
    Say 'Перепишите ключ. Скрипт повторно НЕ запускайте. Ученику пока не отправляйте - напишите Claude: он проверит вход по журналу.' White
  } else {
    Say "ВНИМАНИЕ: неизвестно, изменён ли пароль (сервер не ответил, ответ $lc)." Red
    Say "ВОЗМОЖНЫЙ НОВЫЙ КЛЮЧ: $show" Yellow
    Say 'Перепишите ключ. Скрипт повторно НЕ запускайте. Напишите Claude: он проверит по журналу, какой ключ действует.' White
  }
  $done = $true
} finally {
  if ($sent -and -not $done) {
    Write-Host ''
    Say 'ВНИМАНИЕ: выполнение прервано после отправки нового пароля. Пароль, возможно, изменён.' Red
    Say "ВОЗМОЖНЫЙ НОВЫЙ КЛЮЧ: $show" Yellow
    Say 'Перепишите ключ. Скрипт повторно НЕ запускайте. Напишите Claude.' White
  }
}
}
