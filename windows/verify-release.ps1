$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
foreach($line in Get-Content -LiteralPath (Join-Path $root 'release/SHA256SUMS')){
  if($line -notmatch '^([a-f0-9]{64})  (release/[A-Za-z0-9+.\-]+\.jar)$'){throw 'Invalid release checksum entry'}
  $expected=$Matches[1]; $name=$Matches[2]
  $actual=(Get-FileHash -LiteralPath (Join-Path $root $name) -Algorithm SHA256).Hash
  if($actual -ne $expected){throw "Unexpected checksum for $name"}
}

