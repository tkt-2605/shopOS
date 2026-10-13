# The buttons for tools/netns-bench/windows.sh: three tills, one click each.
#
# A Windows window, because that is where the person testing is sitting. Every
# button runs windows.sh inside WSL as root -- WSL lets Windows do that without
# a password -- and the status line under each till is read back from it.
#
# While this window is open it also holds WSL up. Windows shuts a WSL distro
# down a few seconds after its last terminal closes, and that would be a power
# cut to all three tills that nobody asked for.
#
# Opened from the desktop shortcut, or:
#   powershell -ExecutionPolicy Bypass -File tools\netns-bench\panel.ps1

param([string]$Distro = 'Ubuntu')

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$linuxUser = (& wsl.exe -d $Distro -- whoami | Out-String).Trim()
$script = "/home/$linuxUser/shopos/tools/netns-bench/windows.sh"

function Invoke-Bench([string[]]$words) {
    $out = & wsl.exe -d $Distro -u root -- env "SUDO_USER=$linuxUser" DISPLAY=:0 bash $script @words 2>&1 | Out-String
    return $out.Trim()
}

$keeper = Start-Process wsl.exe -ArgumentList @('-d', $Distro, '--', 'sleep', 'infinity') -WindowStyle Hidden -PassThru

$form = New-Object System.Windows.Forms.Form
$form.Text = 'ShopOS - three tills'
$form.ClientSize = New-Object System.Drawing.Size(560, 430)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

function New-Button([string]$text, [int]$x, [int]$y, [int]$w, [scriptblock]$onClick) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.Location = New-Object System.Drawing.Point($x, $y)
    $b.Size = New-Object System.Drawing.Size($w, 28)
    $b.FlatStyle = 'Flat'
    $b.Add_Click($onClick)
    return $b
}

$log = New-Object System.Windows.Forms.Label
$log.Location = New-Object System.Drawing.Point(12, 395)
$log.Size = New-Object System.Drawing.Size(536, 30)
$log.ForeColor = [System.Drawing.Color]::DimGray
$form.Controls.Add($log)

$statusLabels = @{}

function Update-Status {
    $lines = (Invoke-Bench @('status')) -split "`r?`n"
    foreach ($n in 1..3) {
        $line = $lines | Where-Object { $_ -match "^till $n " } | Select-Object -First 1
        if (-not $line) { $statusLabels[$n].Text = 'no switch yet'; continue }
        $on = $line -match '\son\s'
        $cable = if ($line -match 'cable UP') { 'cable in' } elseif ($line -match 'no switch') { 'no switch' } else { 'cable OUT' }
        $lossy = if ($line -match 'lossy') { ', lossy' } else { '' }
        $statusLabels[$n].Text = "$(if ($on) { 'ON' } else { 'off' }) - $cable$lossy"
        $statusLabels[$n].ForeColor = if (-not $on) { [System.Drawing.Color]::Gray }
            elseif ($cable -ne 'cable in' -or $lossy) { [System.Drawing.Color]::DarkOrange }
            else { [System.Drawing.Color]::DarkGreen }
    }
}

function Do-Bench([string[]]$words) {
    $form.Cursor = 'WaitCursor'
    $log.Text = (Invoke-Bench $words) -replace "`r?`n", '  |  '
    Update-Status
    $form.Cursor = 'Default'
}

foreach ($n in 1..3) {
    $y = 12 + ($n - 1) * 112
    $box = New-Object System.Windows.Forms.GroupBox
    $box.Text = "Till $n   10.77.3.1$n$(if ($n -eq 1) { '   (set up the shop here)' })"
    $box.Location = New-Object System.Drawing.Point(12, $y)
    $box.Size = New-Object System.Drawing.Size(536, 104)

    $status = New-Object System.Windows.Forms.Label
    $status.Location = New-Object System.Drawing.Point(12, 22)
    $status.Size = New-Object System.Drawing.Size(510, 20)
    $status.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
    $statusLabels[$n] = $status
    $box.Controls.Add($status)

    # GetNewClosure: each button keeps its own till number.
    $box.Controls.Add((New-Button 'Switch on'   12  46 120 ({ Do-Bench @('start', "$n") }.GetNewClosure())))
    $box.Controls.Add((New-Button 'Power cut'   138 46 120 ({ Do-Bench @('power', "$n") }.GetNewClosure())))
    $box.Controls.Add((New-Button 'Cable out'   264 46 120 ({ Do-Bench @('cut', "$n") }.GetNewClosure())))
    $box.Controls.Add((New-Button 'Cable in'    390 46 120 ({ Do-Bench @('plug', "$n") }.GetNewClosure())))
    $box.Controls.Add((New-Button 'Bad network (20% lost)' 12 76 246 ({ Do-Bench @('lossy', "$n", '0.2') }.GetNewClosure())))
    $box.Controls.Add((New-Button 'Good network' 264 76 246 ({ Do-Bench @('clean', "$n") }.GetNewClosure())))
    $form.Controls.Add($box)
}

$form.Controls.Add((New-Button 'All on'            12  352 130 { Do-Bench @('up') }))
$form.Controls.Add((New-Button 'All off (keep data)' 148 352 150 { Do-Bench @('down') }))
$form.Controls.Add((New-Button 'Refresh'           304 352 90  { Update-Status }))
$form.Controls.Add((New-Button 'Wipe all data'     418 352 130 {
    $sure = [System.Windows.Forms.MessageBox]::Show(
        'Close all three tills and delete their shops? This cannot be undone.',
        'Wipe all data', 'YesNo', 'Warning')
    if ($sure -eq 'Yes') { Do-Bench @('wipe') }
}))

$form.Add_Shown({ Update-Status })
$form.Add_FormClosed({ if ($keeper -and -not $keeper.HasExited) { Stop-Process -Id $keeper.Id -Force } })
[void]$form.ShowDialog()
