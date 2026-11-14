$ErrorActionPreference = 'Stop'
$PSVersionTable.PSVersion.ToString()
$src = Get-Content .github/rekey-test/rekey.ps1 -Raw -Encoding UTF8
$errs = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$errs)
if ($errs.Count) { $errs; throw 'parse errors' } else { 'parse OK' }

# 1. Равномерность генератора: те же строки, что в скрипте, 15 500 ключей = 310 000 символов
$gen = ($src -split "`n" | Where-Object { $_ -match '^\$a = |^\$n = |^\$rng = |^while \(\$k\.Length' }) -join "`n"
if (($gen -split "`n").Count -ne 4) { throw 'generator lines not found' }
$sb = [scriptblock]::Create($gen + "`n`$k")
$cnt = @{}; $keys = 0
for ($i = 0; $i -lt 15500; $i++) { $kk = & $sb; if ($kk.Length -ne 20) { throw 'bad length' }; foreach ($ch in $kk.ToCharArray()) { $cnt[$ch] = 1 + [int]$cnt[$ch] }; $keys++ }
$total = $keys * 20; $exp = $total / 31; $chi = 0
foreach ($v in $cnt.Values) { $chi += [math]::Pow($v - $exp, 2) / $exp }
"distribution: symbols=$($cnt.Count) total=$total expected=$([math]::Round($exp)) min=$(($cnt.Values | Measure-Object -Minimum).Minimum) max=$(($cnt.Values | Measure-Object -Maximum).Maximum) chi2=$([math]::Round($chi,1)) (df=30, p=0.001 limit 59.7)"
if ($cnt.Count -ne 31 -or $chi -gt 59.7) { throw 'distribution FAIL' }
$bad = @($cnt.Keys | Where-Object { 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'.IndexOf([string]$_) -lt 0 }); if ($bad.Count) { throw "alien symbols $bad" }
'distribution PASS'


# 0. Регрессия: прежний скрипт (без User-Agent) против заглушки, ведущей себя как шлюз Supabase -> 401, как у владельца
function Prep($file, $out) {
  $x = Get-Content $file -Raw -Encoding UTF8
  $x = $x.Replace("'https://ohdeykbkgimvwstkwuuf.supabase.co'", "'http://127.0.0.1:8765'")
  $x = [regex]::Replace($x, '\$ss = Read-Host[^\r\n]*', '$ss = ConvertTo-SecureString $env:FAKE_SECRET -AsPlainText -Force')
  if ($x.Contains('Read-Host') -or -not $x.Contains('127.0.0.1')) { throw "substitution failed: $file" }
  [IO.File]::WriteAllText("$PWD\$out", $x, (New-Object Text.UTF8Encoding $true))
}
function RunMock($mode, $script, $secret) {
  $log = "$PWD\log.jsonl"; Remove-Item $log -ErrorAction SilentlyContinue
  $p = Start-Process python -ArgumentList '.github/rekey-test/mock.py', $mode, $log -PassThru -NoNewWindow
  Start-Sleep 2
  $env:FAKE_SECRET = $secret
  $o = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$PWD\$script" *>&1 | Out-String)
  Stop-Process $p -Force
  $r = @(Get-Content $log -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { $_ | ConvertFrom-Json })
  return @{ out = $o; reqs = $r }
}
Prep '.github/rekey-test/old-rekey.ps1' 'old.ps1'
$x = RunMock 'ok' 'old.ps1' 'sb_secret_FAKE'
"regression old script: " + (($x.out -split "`n" | Where-Object { $_.Trim() }) -join ' | ') + " :: UA=" + $x.reqs[0].ua
if (-not $x.out.Contains('СТОП на шаге 1: ответ 401') -or $x.reqs[0].ua -notmatch 'Mozilla') { throw 'regression not reproduced' }
'regression reproduced (old script -> 401 like on the owner computer)'

# 0b. Проверка только на чтение
Prep '.github/rekey-test/check.ps1' 'chk.ps1'
foreach ($c in @(@{ mode='ok'; secret='sb_secret_FAKE'; tag='ПРОВЕРКА ПРОШЛА' }, @{ mode='ok'; secret='eyJFAKE'; tag='ПРОВЕРКА ПРОШЛА' }, @{ mode='get401'; secret='sb_secret_FAKE'; tag='ПРОВЕРКА НЕ ПРОШЛА: ответ 401' }, @{ mode='wrongemail'; secret='sb_secret_FAKE'; tag='не тот аккаунт' })) {
  $x = RunMock $c.mode 'chk.ps1' $c.secret
  $nonGet = @($x.reqs | Where-Object { $_.m -ne 'GET' }).Count
  $okc = $x.out.Contains($c.tag) -and $nonGet -eq 0 -and $x.out -notmatch 'FAKE' -and @($x.reqs | Where-Object { $_.ua -match 'Mozilla' }).Count -eq 0
  "{0} check [{1}/{2}] requests={3} non-GET={4} :: {5}" -f ($(if ($okc) { 'PASS' } else { 'FAIL' })), $c.mode, $c.secret.Substring(0,3), $x.reqs.Count, $nonGet, (($x.out -split "`n" | Where-Object { $_.Trim() }) -join ' | ')
  if (-not $okc) { throw 'read-only check failed' }
}

# 2. Сценарии против заглушки
$t = $src.Replace("'https://ohdeykbkgimvwstkwuuf.supabase.co'", "'http://127.0.0.1:8765'")
$t = [regex]::Replace($t, '\$ss = Read-Host[^\r\n]*', '$ss = ConvertTo-SecureString $env:FAKE_SECRET -AsPlainText -Force')
if ($t -eq $src -or $t.Contains('Read-Host') -or -not $t.Contains('127.0.0.1')) { throw 'test substitution failed' }
[IO.File]::WriteAllText("$PWD\t.ps1", $t, (New-Object Text.UTF8Encoding $true))
$fail = 0; $shown = @()
foreach ($c in @(
    @{ mode='get401';               secret='sb_secret_FAKE'; put=0; tag='СТОП на шаге 1';               key=$false },
    @{ mode='wrongemail';           secret='sb_secret_FAKE'; put=0; tag='не тот аккаунт';               key=$false },
    @{ mode='put422';               secret='sb_secret_FAKE'; put=1; tag='сервер отказал';               key=$false },
    @{ mode='put500';               secret='sb_secret_FAKE'; put=1; tag='Пароль НЕ изменён: сервер не принял'; key=$false },
    @{ mode='putdrop';              secret='sb_secret_FAKE'; put=1; tag='ГОТОВО';                       key=$true },
    @{ mode='putdrop+login500';     secret='sb_secret_FAKE'; put=1; tag='неизвестно, изменён ли пароль'; key=$true },
    @{ mode='put200+login400';      secret='sb_secret_FAKE'; put=1; tag='пароль ИЗМЕНЁН';               key=$true },
    @{ mode='put200+login500';      secret='sb_secret_FAKE'; put=1; tag='пароль ИЗМЕНЁН';               key=$true },
    @{ mode='ok';                   secret='sb_secret_FAKE'; put=1; tag='ГОТОВО';                       key=$true },
    @{ mode='ok';                   secret='eyJFAKE';        put=1; tag='ГОТОВО';                       key=$true })) {
  $log = "$PWD\log.jsonl"; Remove-Item $log -ErrorAction SilentlyContinue
  $p = Start-Process python -ArgumentList '.github/rekey-test/mock.py', $c.mode, $log -PassThru -NoNewWindow
  Start-Sleep 2
  $env:FAKE_SECRET = $c.secret
  $out = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$PWD\t.ps1" *>&1 | Out-String)
  Stop-Process $p -Force
  $reqs = @(Get-Content $log -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { $_ | ConvertFrom-Json })
  $puts = @($reqs | Where-Object { $_.m -eq 'PUT' })
  $finalPw = if ($reqs.Count) { $reqs[-1].pw_after } else { $null }
  $m = [regex]::Match($out, 'КЛЮЧ: ([A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5})')
  $why = @()
  if ($puts.Count -ne $c.put) { $why += "puts=$($puts.Count)" }
  if (-not $out.Contains($c.tag)) { $why += 'tag' }
  if ($m.Success -ne $c.key) { $why += 'key-shown' }
  if ($out -match 'FAKE') { $why += 'secret-leak' }
  if (@($reqs | Where-Object { $_.ua -match 'Mozilla' -or -not $_.ua }).Count) { $why += 'browser-user-agent' }
  # главный инвариант: если пароль на сервере изменён, показанный ключ - именно он; если ключ не показан, пароль не менялся
  if ($m.Success) {
    $k = $m.Groups[1].Value.Replace('-', '')
    if ($finalPw -cne "Kn-2.$k") { $why += 'shown-key-not-server-password' }
    if (@($puts[0].body.PSObject.Properties).Count -ne 1) { $why += 'put-body-extra-fields' }
    $shown += [pscustomobject]@{ shown = $m.Groups[1].Value; put = $puts[0].body.password; login = (@($reqs | Where-Object { $_.p -like '/auth/v1/token*' })[0]).body }
  } elseif ($finalPw) { $why += 'PASSWORD-CHANGED-BUT-KEY-LOST' }
  $admin = @($reqs | Where-Object { $_.p -like '/auth/v1/admin/*' })
  if (($admin | Where-Object { $_.apikey -ne $c.secret }).Count) { $why += 'apikey' }
  if ($c.secret -like 'eyJ*') { if (($admin | Where-Object { $_.auth -ne "Bearer $($c.secret)" }).Count) { $why += 'bearer' } } elseif (($admin | Where-Object { $_.auth }).Count) { $why += 'auth-header' }
  if (@($reqs | Where-Object { $_.p -like '/auth/v1/token*' -and $_.apikey -notlike 'sb_publishable_*' }).Count) { $why += 'login-key' }
  $last = ($out -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() -replace '[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}', '<ключ>' }) -join ' | '
  "{0} [{1}/{2}] {3} :: {4}" -f ($(if ($why.Count) { 'FAIL ' + ($why -join ',') } else { 'PASS' })), $c.mode, $c.secret.Substring(0,3), "PUT=$($puts.Count) key=$($m.Success)", $last
  if ($why.Count) { $fail++ }
}
$shown | ConvertTo-Json -Depth 4 | Set-Content shown.json -Encoding UTF8
if ($fail) { throw "$fail scenario(s) failed" } else { 'ALL SCENARIOS PASS' }
