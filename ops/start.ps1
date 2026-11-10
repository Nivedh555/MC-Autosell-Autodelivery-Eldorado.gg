param([switch]$CheckOnly, [switch]$NoPrompt, [switch]$MigrateVault, [switch]$MigrateLegacyVault)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
function Read-VaultSecret([string]$prompt) {
  $secureValue = Read-Host -Prompt $prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secureValue.Dispose() }
}
$previousPassphrase = $env:VAULT_PASSPHRASE
$previousOld = $env:AUTOSELL_OLD_VAULT_PASSWORD
$previousNew = $env:AUTOSELL_NEW_VAULT_PASSWORD
$previousConsoleColor = $env:FORCE_COLOR
$dashboardJob = $null
Push-Location -LiteralPath $projectDir
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node >=22.13 before starting Autosell.' }
  $state = (& node (Join-Path $PSScriptRoot 'startup-check.js') | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or -not $state.nodeSupported) { throw 'Node >=22.13 is required.' }
  if ($CheckOnly) { $state | ConvertTo-Json -Compress; if (-not $state.passphraseConfigured) { exit 2 }; exit 0 }
  if ($MigrateVault -or $MigrateLegacyVault) {
    if ($NoPrompt) { throw 'Vault migration requires owner input.' }
    Write-Host 'Stop Autosell first. Migration preserves an encrypted backup; it never resets the stored secrets.'
    if (-not $MigrateLegacyVault) { $env:AUTOSELL_OLD_VAULT_PASSWORD = Read-VaultSecret 'Existing vault passphrase' }
    $newValue = Read-VaultSecret 'New vault passphrase (at least 12 characters)'
    $confirmValue = Read-VaultSecret 'Confirm new vault passphrase'
    if (-not [string]::Equals($newValue,$confirmValue,[StringComparison]::Ordinal)) { throw 'Passphrases do not match; nothing changed.' }
    $env:AUTOSELL_NEW_VAULT_PASSWORD = $newValue
    if ($MigrateLegacyVault) { & node (Join-Path $PSScriptRoot 'vault-maintenance.js') --legacy }
    else { & node (Join-Path $PSScriptRoot 'vault-maintenance.js') }
    exit $LASTEXITCODE
  }
  if (-not $state.passphraseConfigured) {
    if ($NoPrompt) { throw 'VAULT_PASSPHRASE missing. Start Autosell.bat prompts securely; an existing vault needs its original passphrase.' }
    if ($state.vaultExists) {
      Write-Host 'An encrypted vault exists. Enter its original passphrase; it will not be reset or replaced.'
      Write-Host 'For an older built-in passphrase, use ops/start.ps1 -MigrateLegacyVault first.'
      $env:VAULT_PASSPHRASE = Read-VaultSecret 'Unlock existing vault'
    } else {
      $newValue = Read-VaultSecret 'Create a vault passphrase (at least 12 characters; save it securely)'
      $confirmValue = Read-VaultSecret 'Confirm vault passphrase'
      if ($newValue.Length -lt 12 -or -not [string]::Equals($newValue,$confirmValue,[StringComparison]::Ordinal)) { throw 'Matching passphrases of at least 12 characters required; nothing started.' }
      $env:VAULT_PASSPHRASE = $newValue
    }
  }
  Write-Host 'Starting Autosell. Component status and the actual dashboard URL appear after initialization.'
  Write-Host 'No credentials are printed. Use Ctrl+C for graceful shutdown; trading remains subject to its safety checks.'
                                                                                
                                                                               
  if ($Host.UI.SupportsVirtualTerminal -and -not [Console]::IsOutputRedirected -and -not (Test-Path Env:\NO_COLOR) -and $null -eq $env:FORCE_COLOR) {
    $env:FORCE_COLOR = '1'
  }

  # Auto-open the dashboard once its loopback port accepts connections.
  # Best-effort only: never blocks or fails startup, never opens credentials.
  $dashboardPort = 4201
  try {
    $envFile = Join-Path $projectDir '.env'
    if (Test-Path -LiteralPath $envFile) {
      $portLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*API_PORT\s*=\s*(\d{1,5})\s*$' } | Select-Object -First 1
      if ($portLine -and $portLine -match '^\s*API_PORT\s*=\s*(\d{1,5})\s*$') { $dashboardPort = [int]$Matches[1] }
    }
  } catch { }
  try {
    $dashboardJob = Start-Job -ScriptBlock {
      param($port)
      $targets = @(
        @{ Host = '127.0.0.1'; Url = 'http://127.0.0.1:' + $port },
        @{ Host = '::1';       Url = 'http://[::1]:' + $port }
      )
      for ($i = 0; $i -lt 120; $i++) {
        foreach ($target in $targets) {
          try {
            $probe = New-Object System.Net.Sockets.TcpClient
            $probe.Connect($target.Host, $port)
            $probe.Close()
            Start-Process $target.Url
            return
          } catch { }
        }
        Start-Sleep -Milliseconds 500
      }
    } -ArgumentList $dashboardPort
  } catch { $dashboardJob = $null }

  & node (Join-Path $projectDir 'index.js')
  exit $LASTEXITCODE
} catch { Write-Error $_; exit 1 }
finally {
  if ($dashboardJob) {
    Stop-Job -Job $dashboardJob -ErrorAction SilentlyContinue
    Remove-Job -Job $dashboardJob -Force -ErrorAction SilentlyContinue
  }
  $dashboardJob = $null
  $env:VAULT_PASSPHRASE = $previousPassphrase
  $env:AUTOSELL_OLD_VAULT_PASSWORD = $previousOld
  $env:AUTOSELL_NEW_VAULT_PASSWORD = $previousNew
  $env:FORCE_COLOR = $previousConsoleColor
  $newValue = $null; $confirmValue = $null
  Pop-Location
}
