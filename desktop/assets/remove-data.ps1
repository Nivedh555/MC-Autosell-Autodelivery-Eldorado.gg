param([Parameter(Mandatory=$true)][string]$LocalApplicationData)
$ErrorActionPreference = 'Stop'
$parent = [IO.Path]::GetFullPath($LocalApplicationData).TrimEnd('\')
if (-not [IO.Path]::IsPathRooted($LocalApplicationData) -or $parent -eq [IO.Path]::GetPathRoot($parent).TrimEnd('\')) { throw 'Invalid local application data directory' }
if (Get-Process -Name 'Autosell V3','Autosell-Worker' -ErrorAction SilentlyContinue) { throw 'Exit Autosell safely before removing its data' }
$ancestor = [IO.DirectoryInfo]::new($parent)
while ($null -ne $ancestor) {
  if ($ancestor.Exists -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked application data parent detected' }
  $ancestor = $ancestor.Parent
}
$targets = @()
foreach ($name in @('Autosell V3', 'autosell-v3-desktop-updater')) {
  $target = [IO.Path]::GetFullPath((Join-Path $parent $name))
  if ((Split-Path -Parent $target) -ne $parent -or (Split-Path -Leaf $target) -ne $name) { throw 'Unexpected Autosell data directory' }
  if (-not (Test-Path -LiteralPath $target)) { continue }
  # Inspect each directory before descending. A junction or symbolic link could
  # redirect recursive removal to a location outside the owned application root.
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($target)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    $item = Get-Item -Force -LiteralPath $current
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked data was detected. The workspace was preserved for manual review.' }
    foreach ($child in Get-ChildItem -Force -LiteralPath $current) {
      if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked data was detected. The workspace was preserved for manual review.' }
      if ($child.PSIsContainer) { $pending.Push($child.FullName) }
    }
  }
  if ($name -eq 'Autosell V3') {
    $marker = Join-Path $target 'desktop-owner.json'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'The directory has no Autosell desktop ownership marker. Personal data was preserved.' }
    $owner = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
    if ($owner.appId -ne 'gg.autosell.desktop') { throw 'The directory ownership marker is invalid' }
    $lock = Join-Path $target 'workspace\data\process.lock'
    if (Test-Path -LiteralPath $lock -PathType Leaf) {
      $workerId = (Get-Content -Raw -LiteralPath $lock | ConvertFrom-Json).pid
      if (-not ($workerId -is [int] -or $workerId -is [long]) -or $workerId -lt 1) { throw 'Invalid workspace lock. Preserve the data for review.' }
      if (Get-Process -Id $workerId -ErrorAction SilentlyContinue) { throw 'The workspace still has an active backend' }
    }
  } else {
    $marker = Join-Path $target 'autosell-cache.id'
    $marked = (Test-Path -LiteralPath $marker -PathType Leaf) -and ((Get-Content -Raw -LiteralPath $marker).Trim() -eq 'gg.autosell.desktop')
    $unknown = @(Get-ChildItem -Force -LiteralPath $target | Where-Object { $_.Name -notin @('installer.exe','pending','.cache','autosell-cache.id') })
    if (-not $marked -and $unknown.Count -gt 0) { throw 'Unrecognized files in the update cache require manual review' }
  }
  $targets += $target
}
foreach ($target in $targets) {
  Remove-Item -LiteralPath $target -Recurse -Force
  if (Test-Path -LiteralPath $target) { throw 'Some Autosell data could not be removed' }
}
Write-Output 'Removed the owned Autosell desktop data and updater cache.'
