$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
& node -e "const [m,n]=process.versions.node.split('.').map(Number); if(m<22||(m===22&&n<13))throw Error('Install Node.js 24 LTS');require('node:sqlite')"
if($LASTEXITCODE -ne 0){throw 'Install Node.js 24 LTS, then reopen this window'}
& npm.cmd ci --no-audit --no-fund
if($LASTEXITCODE -ne 0){throw 'npm install failed'}
& npx.cmd --no-install playwright install chromium
if($LASTEXITCODE -ne 0){throw 'Chromium installation failed'}
& "$PSScriptRoot/verify-release.ps1"
Write-Host 'Installed. Open Start-Windows.cmd to start the dashboard.'

