param([Parameter(Mandatory=$true)][string]$InstanceDirectory,[Parameter(Mandatory=$true)][string]$PairingFile)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$instance=(Resolve-Path -LiteralPath $InstanceDirectory).Path
if(!(Test-Path -LiteralPath $instance -PathType Container)){throw 'Select the game directory of the Fabric instance'}
$pair=(Resolve-Path -LiteralPath $PairingFile).Path
$config=Get-Content -LiteralPath $pair -Raw | ConvertFrom-Json
if($config.version -ne '26.3' -or $config.accountId -notmatch '^(buyer|seller)[1-9][0-9]?$' -or $config.token -notmatch '^[0-9a-f]{64}$'){throw 'Invalid V3 pairing file'}
& "$PSScriptRoot/verify-release.ps1"
$mods=Join-Path $instance 'mods'
$cfg=Join-Path $instance 'config'
[void][IO.Directory]::CreateDirectory($mods);[void][IO.Directory]::CreateDirectory($cfg)
foreach($jar in Get-ChildItem -LiteralPath (Join-Path $root 'release') -Filter '*.jar'){Copy-Item -LiteralPath $jar.FullName -Destination $mods -Force}
$dest=Join-Path $cfg 'autosell-bridge.json'
if($pair -ne $dest){Copy-Item -LiteralPath $pair -Destination $dest -Force}
Write-Host 'Installed both JARs and the pairing file. Start this instance with Fabric Loader 0.20.1 on Minecraft 26.3.'

