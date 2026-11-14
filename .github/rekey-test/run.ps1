$PSVersionTable.PSVersion.ToString()
$src = Get-Content .github/rekey-test/rekey.ps1 -Raw -Encoding UTF8
$errs = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$errs)
if ($errs.Count) { $errs; throw 'parse errors' } else { 'parse OK' }
# для теста: адрес заглушки и фиктивный секрет вместо ввода с клавиатуры
$t = $src.Replace("'https://ohdeykbkgimvwstkwuuf.supabase.co'", "'http://127.0.0.1:8765'")
$t = [regex]::Replace($t, '\$ss = Read-Host[^\r\n]*', '$ss = ConvertTo-SecureString $env:FAKE_SECRET -AsPlainText -Force')
if ($t -eq $src -or $t.Contains('Read-Host')) { throw 'test substitution failed' }
[IO.File]::WriteAllText("$PWD\t.ps1", $t, (New-Object Text.UTF8Encoding $true))
$fail = 0
foreach ($c in @(
    @{ mode='get401';     secret='sb_secret_FAKE'; put=0; key=$false },
    @{ mode='wrongemail'; secret='sb_secret_FAKE'; put=0; key=$false },
    @{ mode='put500';     secret='sb_secret_FAKE'; put=1; key=$false },
    @{ mode='login400';   secret='sb_secret_FAKE'; put=1; key=$false },
    @{ mode='ok';         secret='sb_secret_FAKE'; put=1; key=$true },
    @{ mode='ok';         secret='eyJFAKE';        put=1; key=$true })) {
  $log = "$PWD\log-$($c.mode).jsonl"; Remove-Item $log -ErrorAction SilentlyContinue
  $p = Start-Process python -ArgumentList '.github/rekey-test/mock.py', $c.mode, $log -PassThru -NoNewWindow
  Start-Sleep 2
  $env:FAKE_SECRET = $c.secret
  $out = (& powershell -NoProfile -ExecutionPolicy Bypass -File "$PWD\t.ps1" *>&1 | Out-String)
  Stop-Process $p -Force
  $reqs = @(Get-Content $log -ErrorAction SilentlyContinue | ForEach-Object { $_ | ConvertFrom-Json })
  $puts = @($reqs | Where-Object { $_.m -eq 'PUT' })
  $m = [regex]::Match($out, 'КЛЮЧ: ([A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5})')
  $ok = ($puts.Count -eq $c.put) -and ($m.Success -eq $c.key) -and ($out -notmatch 'FAKE')
  if ($m.Success) {
    $k = $m.Groups[1].Value.Replace('-', '')
    $ok = $ok -and ($k -cmatch '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{20}$') -and ($puts[0].body.password -ceq "Kn-2.$k")
    $ok = $ok -and (@($puts[0].body.PSObject.Properties).Count -eq 1)
    $login = @($reqs | Where-Object { $_.p -like '/auth/v1/token*' })[0]
    $ok = $ok -and ($login.apikey -like 'sb_publishable_*') -and ($login.body.password -ceq "Kn-2.$k")
    $ok = $ok -and (@($reqs | Where-Object { $_.p -like '/auth/v1/logout*' }).Count -eq 1)
  }
  $admin = @($reqs | Where-Object { $_.p -like '/auth/v1/admin/*' })
  $authOk = if ($c.secret -like 'eyJ*') { ($admin | Where-Object { $_.auth -ne "Bearer $($c.secret)" }).Count -eq 0 } else { ($admin | Where-Object { $_.auth }).Count -eq 0 }
  $ok = $ok -and $authOk -and (($admin | Where-Object { $_.apikey -ne $c.secret }).Count -eq 0)
  $last = ($out -split "`n" | Where-Object { $_ -match 'СТОП|Шаг|КЛЮЧ' } | ForEach-Object { $_ -replace '[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}', '<ключ>' }) -join ' | '
  "{0} [{1}/{2}] PUT={3} key={4} :: {5}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $c.mode, $c.secret.Substring(0,3), $puts.Count, $m.Success, $last
  if (-not $ok) { $fail++ }
}
if ($fail) { throw "$fail scenario(s) failed" } else { 'ALL PASS' }
