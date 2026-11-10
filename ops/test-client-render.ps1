param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$JavaHome = $env:JAVA_HOME
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
if (!$JavaHome -or !(Test-Path -LiteralPath (Join-Path $JavaHome 'bin/java.exe'))) {
  throw 'Pass -JavaHome with your Java 25 installation.'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($output)
$temporaryRoot = [IO.Path]::GetTempPath().TrimEnd('\')
$stage = Join-Path $temporaryRoot ('autosell-render-test-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($stage)
$savedJava = $env:JAVA_HOME
try {
  foreach ($part in @('build.gradle','gradlew.bat','gradle','gradle.properties','settings.gradle','src')) {
    Copy-Item -Recurse -LiteralPath (Join-Path $project "client-mod/$part") -Destination $stage
  }
  Copy-Item -LiteralPath (Join-Path $project 'test/client/RenderTest.java') -Destination (Join-Path $stage 'src/main/java/app/autosell/bridge/RenderTest.java')
  $manifestPath = Join-Path $stage 'src/main/resources/fabric.mod.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $manifest.entrypoints | Add-Member -NotePropertyName 'fabric-client-gametest' -NotePropertyValue @('app.autosell.bridge.RenderTest')
  $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  Add-Content -LiteralPath (Join-Path $stage 'build.gradle') -Value "loom { runs { client { vmArg '-Dfabric.client.gametest'; vmArg '-Dfabric.client.gametest.modid=autosell_bridge' } } }"
  $env:JAVA_HOME = $JavaHome
  Push-Location $stage
  try {
    & .\gradlew.bat --console plain runClient -x downloadAssets *> (Join-Path $output 'renderer.log')
    $result = $LASTEXITCODE
  } finally { Pop-Location }
  if ($result -ne 0) { throw "Minecraft render test failed. Read $output/renderer.log" }
  foreach ($file in Get-ChildItem -LiteralPath (Join-Path $stage 'run') -File -Filter 'fixture-*') {
    Copy-Item -LiteralPath $file.FullName -Destination $output -Force
  }
  @'
const fs = require('node:fs');
const path = require('node:path');
const [root, output] = process.argv.slice(2);
const {cropReceipt} = require(path.join(root, 'marketplace', 'receipt-crop'));
const expectedText = ['You paid FixturePlayer $ 100M', 'You paid FixturePlayer $ 12M'];
for (const layout of ['854-480-1', '1280-720-2', '1280-720-3']) {
  const base = path.join(output, 'fixture-' + layout);
  const manifest = JSON.parse(fs.readFileSync(base + '.json'));
  if (new Set(manifest.lines.map(line => line.id)).size !== expectedText.length) {
    throw Error('Expected two distinct message occurrences for ' + layout);
  }
  const spec = {orderId:'local-render-regression', lines:expectedText.map((text, i) => ({text, id:manifest.lines[i].id}))};
  fs.writeFileSync(base + '-crop.png', cropReceipt(fs.readFileSync(base + '.png'), manifest, spec));
}
'@ | node - $project $output
  if ($LASTEXITCODE -ne 0) { throw 'Backend validation rejected a rendered Minecraft fixture.' }
  Write-Host "Minecraft render and crop checks passed. Synthetic local fixtures saved to $output"
} finally {
  $env:JAVA_HOME = $savedJava
  $resolved = [IO.Path]::GetFullPath($stage)
  if ([IO.Path]::GetDirectoryName($resolved) -ne $temporaryRoot -or ![IO.Path]::GetFileName($resolved).StartsWith('autosell-render-test-')) {
    throw 'Unexpected test directory. Cleanup stopped.'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
