<#
  Выпуск одноразовых кодов раннего доступа (Friends & Family) — то же, что tools/ff-invite-codes.mjs, без Node.js.

  Запуск (PowerShell, в папке репозитория):
    powershell -ExecutionPolicy Bypass -File .\tools\ff-invite-codes.ps1
  По умолчанию: 1 код, quota 1, метка smoke, действует до 19.10.2026 00:00 МСК. Для выпуска F&F, например:
    ... -Count 15 -Label "F&F 19-23.10" -Expires 2026-10-24T00:00:00+03:00

  Печатает:
    1) открытые коды — раздать лично (никуда не сохранять, не присылать в чат, не вставлять в SQL);
    2) SQL только с sha256 кодов — выполнить в Supabase SQL Editor (или передать тому, кто выполнит).
  Ничего не сохраняет на диск, не обращается к сети и к базе.
  Алфавит, формат и нормализация — как в ff-invite-codes.mjs и private.invite_code_normalize().
#>
param(
  [int]$Count = 1,
  [int]$Quota = 1,
  [string]$Label = 'smoke',
  [string]$Expires = '2026-10-19T00:00:00+03:00',
  [string[]]$HashOnly = @()   # проверка: только посчитать хэш данных кодов (без выпуска)
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 29 символов без похожих (0/O, 1/I/L, U/V): 12 символов ≈ 58 бит
$ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789'
# кириллические двойники → латиница (АВСЕНКМОРТХУЗ / авсенкмортхуз); коды символов — чтобы файл не зависел от кодировки
$CYR = -join ([int[]](0x410,0x412,0x421,0x415,0x41D,0x41A,0x41C,0x41E,0x420,0x422,0x425,0x423,0x417,
                     0x430,0x432,0x441,0x435,0x43D,0x43A,0x43C,0x43E,0x440,0x442,0x445,0x443,0x437) | ForEach-Object { [char]$_ })
$LAT = 'ABCEHKMOPTXY3abcehkmoptxy3'

function Normalize([string]$c) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $c.ToCharArray()) {
    $i = $CYR.IndexOf($ch)
    $x = if ($i -ge 0) { $LAT[$i] } else { $ch }
    if ([string]$x -cmatch '^[0-9A-Za-z]$') { [void]$sb.Append($x) }
  }
  return $sb.ToString().ToUpperInvariant()
}
function Sha256Hex([string]$s) {
  $h = [System.Security.Cryptography.SHA256]::Create()
  try { return -join ($h.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s)) | ForEach-Object { $_.ToString('x2') }) } finally { $h.Dispose() }
}
function SqlText([string]$v) { if ($null -eq $v -or $v -eq '') { 'null' } else { "'" + $v.Replace("'", "''") + "'" } }

if ($HashOnly.Count) {
  foreach ($c in $HashOnly) { (Normalize $c) + ' ' + (Sha256Hex (Normalize $c)) }
  exit 0
}

$parsed = [DateTimeOffset]::MinValue
if ($Expires -and ($Expires -notmatch '(Z|[+-]\d\d:\d\d)$' -or -not [DateTimeOffset]::TryParse($Expires, [ref]$parsed))) {
  Write-Host '-Expires: ISO 8601 с часовым поясом, например 2026-10-19T00:00:00+03:00' -ForegroundColor Red; exit 1
}
if ($Count -lt 1 -or $Count -gt 200 -or $Quota -lt 1) {
  Write-Host 'Count — от 1 до 200, Quota — от 1' -ForegroundColor Red; exit 1
}

# криптографический генератор; отбрасывание байтов ≥ 232 (= 8 × 29) — равномерно, как crypto.randomInt
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$buf = New-Object byte[] 1
function NewCode {
  $s = ''
  while ($s.Length -lt 12) { $rng.GetBytes($buf); if ($buf[0] -lt 232) { $s += $ALPHABET[$buf[0] % 29] } }
  return $s.Substring(0, 4) + '-' + $s.Substring(4, 4) + '-' + $s.Substring(8)
}
$codes = New-Object System.Collections.Generic.List[string]
while ($codes.Count -lt $Count) { $c = NewCode; if ((Normalize $c).Length -eq 12 -and -not $codes.Contains($c)) { $codes.Add($c) } }

Write-Host '# Коды (раздать лично; не сохранять в репозиторий, не присылать в чат, не вставлять в SQL):' -ForegroundColor Yellow
foreach ($c in $codes) { Write-Host $c -ForegroundColor Yellow }
Write-Host ''
Write-Host '-- SQL для Supabase SQL Editor (только хэши):'
$exp = if ($Expires) { ', ' + (SqlText $Expires) + '::timestamptz' } else { '' }
foreach ($c in $codes) { Write-Host ("select private.admin_add_beta_invite('" + (Sha256Hex (Normalize $c)) + "', $Quota, " + (SqlText $Label) + "$exp);") }
