& {
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = 'https://ohdeykbkgimvwstkwuuf.supabase.co'
$uid  = 'c7b537ae-8fbb-4c9a-a047-26c8ccda1cfe'
$mail = 'id-kn-ek83ff@id.konspekt.invalid'
$pub  = 'sb_publishable_7t0cfHxy6z5QU4N1qW-4Og_6qcPhaQ_'
function Code($e) { try { [int]$e.Exception.Response.StatusCode } catch { 'нет ответа' } }

$ss = Read-Host 'Секретный ключ проекта (при вводе не виден)' -AsSecureString
$s = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))
if (-not $s) { Write-Host 'СТОП: секретный ключ не введён. Ничего не изменено.' -ForegroundColor Red; return }
$h = @{ apikey = $s }
if ($s.StartsWith('eyJ')) { $h['Authorization'] = "Bearer $s" }

# Шаг 1. Проверяем, что это именно KN-EK83FF
try { $u = Invoke-RestMethod -Method Get -Uri "$base/auth/v1/admin/users/$uid" -Headers $h }
catch { Write-Host "СТОП на шаге 1: ответ $(Code $_). Ничего не изменено." -ForegroundColor Red; return }
if ($u.id -ne $uid -or $u.email -ne $mail) { Write-Host 'СТОП: найден не тот аккаунт. Ничего не изменено.' -ForegroundColor Red; return }
Write-Host 'Шаг 1: аккаунт KN-EK83FF найден' -ForegroundColor Green

# Шаг 2. Новый случайный ключ: 20 символов, латиница без O/I/L и цифры 2-9
$a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $b = New-Object byte[] 1; $k = ''
while ($k.Length -lt 20) { $rng.GetBytes($b); if ($b[0] -lt 248) { $k += $a[$b[0] % 31] } }

# Шаг 3. Меняем только пароль (больше ничего не передаём)
$body = @{ password = "Kn-2.$k" } | ConvertTo-Json
try { $r = Invoke-RestMethod -Method Put -Uri "$base/auth/v1/admin/users/$uid" -Headers $h -ContentType 'application/json' -Body $body }
catch { Write-Host "СТОП на шаге 3: ответ $(Code $_). Пароль НЕ изменён, ключ не показан." -ForegroundColor Red; return }
if ($r.id -ne $uid -or $r.email -ne $mail) { Write-Host 'СТОП: неожиданный ответ на шаге 3. Ключ не показан. Напишите Claude.' -ForegroundColor Red; return }
Write-Host 'Шаг 3: пароль обновлён' -ForegroundColor Green

# Шаг 4. Проверяем вход новым ключом так же, как приложение, и сразу выходим
$lb = @{ email = $mail; password = "Kn-2.$k" } | ConvertTo-Json
try { $t = Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{ apikey = $pub } -ContentType 'application/json' -Body $lb }
catch { Write-Host "СТОП на шаге 4: вход новым ключом не прошёл (ответ $(Code $_)). Ключ не показан. Напишите Claude." -ForegroundColor Red; return }
if ($t.user.id -ne $uid) { Write-Host 'СТОП: вход привёл не в тот аккаунт. Ключ не показан. Напишите Claude.' -ForegroundColor Red; return }
try { Invoke-RestMethod -Method Post -Uri "$base/auth/v1/logout?scope=local" -Headers @{ apikey = $pub; Authorization = "Bearer $($t.access_token)" } | Out-Null } catch {}
Write-Host 'Шаг 4: вход новым ключом проверен' -ForegroundColor Green

Write-Host ''
Write-Host ('ID: KN-EK83FF   НОВЫЙ КЛЮЧ: ' + (($k -split '(.{5})' | Where-Object { $_ }) -join '-')) -ForegroundColor Yellow
Write-Host 'Перепишите ключ на бумагу и закройте окно PowerShell.'
}
