param([Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)][string]$LocalApplicationData,[switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$folder = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
$local = [IO.Path]::GetFullPath($LocalApplicationData).TrimEnd('\')
if (-not [IO.Path]::IsPathRooted($Directory) -or $folder -eq [IO.Path]::GetPathRoot($folder).TrimEnd('\')) { throw 'Select a dedicated application installation folder' }
foreach ($reserved in @((Join-Path $local 'Autosell V3'), (Join-Path $local 'autosell-v3-desktop-updater'))) {
  if (($reserved + '\').StartsWith($folder + '\',[StringComparison]::OrdinalIgnoreCase) -or ($folder + '\').StartsWith($reserved + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Application files and the Autosell data directories must be separate' }
}
foreach ($location in @($folder,$local)) {
  $probe = [IO.DirectoryInfo]::new($location)
  while ($null -ne $probe) {
    if ($probe.Exists -and ($probe.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'A linked directory cannot be used for this installation' }
    $probe = $probe.Parent
  }
}
if (-not (Test-Path -LiteralPath $folder)) { if ($Uninstall) { throw 'Installation directory is missing' }; exit 0 }
$contents = @(Get-ChildItem -LiteralPath $folder -Force)
if ($contents.Count -eq 0 -and -not $Uninstall) { exit 0 }
$marker = Join-Path $folder 'autosell-install.id'
$owned = (Test-Path -LiteralPath $marker -PathType Leaf) -and ((Get-Content -Raw -LiteralPath $marker).Trim() -eq 'gg.autosell.desktop')
if (-not $owned) { throw 'Choose an empty folder. This directory does not contain an Autosell desktop installer ownership marker.' }
if (-not (Test-Path -LiteralPath (Join-Path $folder 'resources\app.asar') -PathType Leaf)) { throw 'The existing desktop installation is incomplete or unrecognized' }
