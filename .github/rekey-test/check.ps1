& {
# Проверка доступа к Admin API БЕЗ изменений: только чтение аккаунта KN-EK83FF.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = 'https://ohdeykbkgimvwstkwuuf.supabase.co'
$uid  = 'c7b537ae-8fbb-4c9a-a047-26c8ccda1cfe'
$mail = 'id-kn-ek83ff@id.konspekt.invalid'
$ua   = 'konspekt-admin-rekey/1.0'
$ss = Read-Host 'Секретный ключ проекта (при вводе не виден)' -AsSecureString
$s = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))
if (-not $s) { Write-Host 'СТОП: ключ не введён.' -ForegroundColor Red; return }
$h = @{ apikey = $s }
if ($s.StartsWith('eyJ')) { $h['Authorization'] = "Bearer $s" }
try { $u = Invoke-RestMethod -UserAgent $ua -Method Get -Uri "$base/auth/v1/admin/users/$uid" -Headers $h -TimeoutSec 60 }
catch { $c = try { [int]$_.Exception.Response.StatusCode } catch { 0 }; Write-Host "ПРОВЕРКА НЕ ПРОШЛА: ответ $c. Ничего не изменено." -ForegroundColor Red; return }
if ($u.id -eq $uid -and $u.email -eq $mail) { Write-Host 'ПРОВЕРКА ПРОШЛА: доступ к Admin API есть, аккаунт KN-EK83FF найден. Ничего не изменено.' -ForegroundColor Green }
else { Write-Host 'ПРОВЕРКА НЕ ПРОШЛА: найден не тот аккаунт. Ничего не изменено.' -ForegroundColor Red }
}
