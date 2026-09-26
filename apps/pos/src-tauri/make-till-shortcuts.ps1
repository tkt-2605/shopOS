# Creates three desktop shortcuts, one per till exe built by build-tills.mjs.
# Run after `npm run till:build` (from apps/pos) has produced
# target/tills/till-1..3/shopos-pos.exe.
$ErrorActionPreference = 'Stop'
$srcTauri = $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell

foreach ($n in 1..3) {
    $exe = Join-Path $srcTauri "target\tills\till-$n\shopos-pos.exe"
    if (-not (Test-Path $exe)) {
        Write-Warning "Missing $exe -- run 'npm run till:build' in apps/pos first."
        continue
    }
    $linkPath = Join-Path $desktop "ShopOS Till $n.lnk"
    $shortcut = $shell.CreateShortcut($linkPath)
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = Split-Path $exe
    $shortcut.Description = "ShopOS -- Till $n (its own local database)"
    $shortcut.Save()
    Write-Host "Created $linkPath"
}
