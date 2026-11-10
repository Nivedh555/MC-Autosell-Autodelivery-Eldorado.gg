$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if(!(Test-Path -LiteralPath 'node_modules/express')){throw 'Run Install-Windows.cmd first'}
if(!$env:VAULT_PASSPHRASE){
  $secure=Read-Host 'Enter your vault passphrase' -AsSecureString
  $pwdValue=[Net.NetworkCredential]::new('',$secure).Password
  if(!(Test-Path -LiteralPath 'data/vault.enc')){
    if($pwdValue.Length -lt 12){throw 'Use at least 12 characters for the new vault'}
    $repeat=Read-Host 'Confirm new vault passphrase' -AsSecureString
    if($pwdValue -cne [Net.NetworkCredential]::new('',$repeat).Password){throw 'Passphrases differ'}
  }
  $env:VAULT_PASSPHRASE=$pwdValue
  Remove-Variable pwdValue
}
try{
  Write-Host 'Open http://127.0.0.1:4203 after the dashboard starts. Keep this window open.'
  & node index.js
  if($LASTEXITCODE -ne 0){throw "Autosell stopped (exit $LASTEXITCODE)"}
}finally{
  Remove-Item Env:VAULT_PASSPHRASE -ErrorAction SilentlyContinue
}

