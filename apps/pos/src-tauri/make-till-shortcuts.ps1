# Creates three desktop shortcuts, one per till exe built by build-tills.mjs.
# Run after `npm run till:build` (from apps/pos) has produced
# target/tills/till-1..3/shopos-pos.exe.
$ErrorActionPreference = 'Stop'
$srcTauri = $PSScriptRoot
# Wherever Cargo builds on this PC (.cargo/config.toml may move it off C:).
$targetDir = (cargo metadata --format-version 1 --no-deps --manifest-path (Join-Path $srcTauri 'Cargo.toml') | ConvertFrom-Json).target_directory
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell

foreach ($n in 1..3) {
    $exe = Join-Path $targetDir "tills\till-$n\shopos-pos.exe"
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
