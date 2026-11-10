# Run real NSIS install and uninstall only in the hosted Windows validation job.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:AUTOSELL_CI_RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) {
    throw 'This installer test requires a disposable GitHub-hosted Windows runner.'
}

$desktopDir = Split-Path -Parent $PSScriptRoot
$installers = @(Get-ChildItem -LiteralPath (Join-Path $desktopDir 'dist') -Filter 'Autosell-Setup-*-x64.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one freshly built Windows x64 installer.' }
$setup = $installers[0].FullName
$local = [Environment]::GetFolderPath('LocalApplicationData')
$profile = Join-Path $local 'Autosell V3'
$cache = Join-Path $local 'autosell-v3-desktop-updater'
$programs = [Environment]::GetFolderPath('Programs')
$appLink = Join-Path $programs 'Autosell V3.lnk'
$uninstallLink = Join-Path $programs 'Uninstall Autosell V3.lnk'
$desktopLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Autosell V3.lnk'
$id = [Guid]::NewGuid().ToString('N')
$scratch = Join-Path $env:RUNNER_TEMP "autosell-lifecycle-$id"
$installRoot = Join-Path $scratch 'Autosell V3'
$neighbor = Join-Path $local "Autosell V3-neighbor-$id.txt"
$appExe = Join-Path $installRoot 'Autosell V3.exe'
$uninstaller = Join-Path $installRoot 'Uninstall Autosell V3.exe'
$worker = Join-Path $installRoot 'resources\runtime\node\Autosell-Worker.exe'

# Even on a hosted machine, an existing installation, hidden file or registration
# would invalidate the clean-machine test. Never rename or delete one to make room.
foreach ($entry in @($profile, $cache, $appLink, $uninstallLink, $desktopLink, $scratch, $neighbor,
                     (Join-Path $local 'Programs\Autosell V3'))) {
    if (Test-Path -LiteralPath $entry) { throw "The installer test requires this path to be absent: $entry" }
}
foreach ($hive in @('HKCU:', 'HKLM:')) {
    $registry = Join-Path $hive 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
    $registered = Get-ChildItem -LiteralPath $registry -ErrorAction SilentlyContinue |
        Where-Object { $_.GetValue('DisplayName') -eq 'Autosell V3' }
    if ($registered) { throw 'A pre-existing Autosell installation is registered.' }
}
if (Get-Process -Name 'Autosell V3','Autosell-Worker' -ErrorAction SilentlyContinue) {
    throw 'A pre-existing Autosell instance is active.'
}

function Invoke-Nsis([string]$File, [string]$Arguments, [int]$ExpectedExit = 0) {
    # NSIS requires the final /D= and _?= values to be unquoted even with spaces.
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(300000)) { throw "Timed out running $File $Arguments" }
    if ($process.ExitCode -ne $ExpectedExit) {
        throw "$File $Arguments exited $($process.ExitCode), expected $ExpectedExit"
    }
}
function Uninstall-TestApp([string]$Options = '', [int]$ExpectedExit = 0) {
    # Run a copy with _?= just as electron-builder does during an upgrade. This
    # waits for the actual uninstaller and exposes its own status to the test.
    $copy = Join-Path $scratch 'uninstaller-test.exe'
    Copy-Item -LiteralPath $uninstaller -Destination $copy -Force
    Invoke-Nsis $copy "/S /currentuser $Options _?=$installRoot" $ExpectedExit
}
function Assert-Installed {
    foreach ($file in @($appExe, $worker, $uninstaller, $appLink, $uninstallLink)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing installed file: $file" }
    }
    $links = New-Object -ComObject WScript.Shell
    if ($links.CreateShortcut($appLink).TargetPath -ne $appExe -or
        $links.CreateShortcut($uninstallLink).TargetPath -ne $uninstaller) { throw 'Start Menu shortcut target mismatch' }
    if (Test-Path -LiteralPath $desktopLink) { throw 'Silent install created an unselected desktop shortcut' }
}
function Assert-Uninstalled {
    foreach ($file in @($appExe, $uninstaller, $worker, $appLink, $uninstallLink, $desktopLink)) {
        if (Test-Path -LiteralPath $file) { throw "Uninstall left an installed program or shortcut: $file" }
    }
}

$null = New-Item -ItemType Directory -Path $scratch
[IO.File]::WriteAllText($neighbor, $id)
$fixtures = @((Join-Path $profile 'workspace\data\hidden-journal.bin'), (Join-Path $cache 'pending\test.blockmap'))
function Assert-Fixtures {
    foreach ($file in @($fixtures) + @($neighbor)) {
        if ([IO.File]::ReadAllText($file) -cne $id) { throw "A fixture was changed: $file" }
    }
}

# Seed the default workspace after the absence checks. Boot the application in
# its separate generated smoke-test profile, so these synthetic bytes are never
# opened as journals or used as service credentials.
$null = New-Item -ItemType Directory -Path (Split-Path -Parent $fixtures[0]) -Force
[IO.File]::WriteAllText((Join-Path $profile 'desktop-owner.json'), '{"appId":"gg.autosell.desktop"}')
[IO.File]::WriteAllText($fixtures[0], $id)
[IO.File]::SetAttributes($fixtures[0], [IO.FileAttributes]::Hidden)
Invoke-Nsis $setup "/S /currentuser /D=$profile" 25
if ((Test-Path -LiteralPath (Join-Path $profile 'Autosell V3.exe')) -or [IO.File]::ReadAllText($fixtures[0]) -cne $id) {
    throw 'Setup did not preserve the protected workspace after refusing the overlapping destination'
}

Invoke-Nsis $setup "/S /currentuser /D=$installRoot"
Assert-Installed
$null = New-Item -ItemType Directory -Path (Split-Path -Parent $fixtures[1]) -Force
[IO.File]::WriteAllText($fixtures[1], $id)
$env:AUTOSELL_TEST_EXECUTABLE = $appExe
$env:AUTOSELL_DESKTOP_TEST = '1'
$env:PATH = Join-Path $env:SystemRoot 'System32'
& $worker (Join-Path $PSScriptRoot 'test-installed.js')
if ($LASTEXITCODE -ne 0) { throw 'The installed application failed its GUI/runtime smoke test' }

# This named worker only keeps a timer open. Process detection should refuse
# both the uninstall and its destructive option without stopping the worker.
$idle = Start-Process -FilePath $worker -ArgumentList '-e "setInterval(()=>{},10000)"' -WindowStyle Hidden -PassThru
try {
    Uninstall-TestApp '--remove-all-autosell-data --confirm-remove-all-autosell-data' 23
    if ($idle.HasExited) { throw 'Uninstall stopped a running worker' }
    Assert-Installed
    Assert-Fixtures
} finally {
    if (-not $idle.HasExited) { $idle.Kill(); $idle.WaitForExit() }
}

Uninstall-TestApp
Assert-Uninstalled
Assert-Fixtures
Invoke-Nsis $setup "/S /currentuser /D=$installRoot"
Assert-Installed
Assert-Fixtures

# Exercise the real replacement path with the same artifact, including its
# internal --updated old-uninstaller invocation. The independently seeded data
# must survive. Then challenge the old-uninstall path with both purge flags.
Invoke-Nsis $setup "/S /currentuser --updated /D=$installRoot"
Assert-Installed
Assert-Fixtures
Uninstall-TestApp '--updated --remove-all-autosell-data --confirm-remove-all-autosell-data'
Assert-Uninstalled
Assert-Fixtures
Invoke-Nsis $setup "/S /currentuser /D=$installRoot"
Assert-Installed
Assert-Fixtures

Uninstall-TestApp '--remove-all-autosell-data --confirm-remove-all-autosell-data'
Assert-Uninstalled
foreach ($root in @($profile, $cache)) {
    if (Test-Path -LiteralPath $root) { throw "Explicit uninstall left an owned data directory: $root" }
}
if ([IO.File]::ReadAllText($neighbor) -cne $id) { throw 'The file beside the owned folders changed' }
Write-Host 'Passed installed desktop launch, shortcut targets, active-worker refusal, default retention, upgrade retention and explicit data removal.'
