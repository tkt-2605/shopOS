<#
  ShopOS ports: the one-time setup for a shop PC. Run it once as administrator,
  and again after installing anything big (Docker, WSL, Hyper-V, a VPN).
  Running it twice changes nothing.

    powershell -ExecutionPolicy Bypass -File tools\windows\setup-ports.ps1
    powershell -ExecutionPolicy Bypass -File tools\windows\setup-ports.ps1 -StartTill "C:\...\till-1\shopos-pos.exe"

  What ShopOS uses:
    7801 TCP  tills syncing with the main          shop network
    7802 UDP  tills finding each other             shop network
    7802 TCP  the storefront, main till only       this PC only (127.0.0.1)

  Windows cannot set a port aside for one program: whoever opens it first has
  it. What this does instead:
    1. Keeps Windows' random ports (handed to every program that does not ask
       for one, and the pool Docker, WSL and Hyper-V reserve from) at
       49152-65535, well away from 7801-7802. Some installers move that pool
       down to 1025, and then any program can land on 7801 by chance.
    2. Removes reservations that cover 7801-7802, and says what made them.
    3. Lets the tills through the firewall on Private networks only.
    4. Keeps the Cloudflare tunnel starting with Windows.
    5. With -StartTill, starts that till when you sign in, so it opens its
       ports before anything else can.
    6. Says who holds each port right now.
#>
param([string]$StartTill = '')

$ErrorActionPreference = 'Stop'
$Group = 'ShopOS tills'
$Lo = 7801; $Hi = 7802

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Run this as administrator (right-click PowerShell, Run as administrator).' -ForegroundColor Red; exit 1 }

function Say($text, $colour = 'Gray') { Write-Host $text -ForegroundColor $colour }

# 1. Windows' pool of random ports
foreach ($proto in 'tcp', 'udp') {
  $text = netsh int ipv4 show dynamicport $proto | Out-String
  $start = [int]([regex]::Match($text, 'Start Port\s*:\s*(\d+)').Groups[1].Value)
  $count = [int]([regex]::Match($text, 'Number of Ports\s*:\s*(\d+)').Groups[1].Value)
  if ($start -le $Hi -and $start + $count - 1 -ge $Lo) {
    netsh int ipv4 set dynamicport $proto start=49152 num=16384 | Out-Null
    Say "Random $proto ports were $start-$($start + $count - 1), over 7801-7802. Moved back to 49152-65535 (takes effect after a restart)." Yellow
  } else {
    Say "Random $proto ports: $start-$($start + $count - 1). Clear of 7801-7802." Green
  }
}

# 2. Reservations over our ports
$left = $false
foreach ($proto in 'tcp', 'udp') {
  $rows = netsh int ipv4 show excludedportrange protocol=$proto | Select-String '^\s*(\d+)\s+(\d+)(\s+\*)?'
  foreach ($r in $rows) {
    $a = [int]$r.Matches[0].Groups[1].Value; $b = [int]$r.Matches[0].Groups[2].Value
    if ($a -le $Hi -and $b -ge $Lo) {
      if ($r.Matches[0].Groups[3].Success) {
        netsh int ipv4 delete excludedportrange protocol=$proto startport=$a numberofports=$($b - $a + 1) | Out-Null
        Say "Removed a $proto reservation $a-$b that covered 7801-7802." Yellow
      } else {
        $left = $true
        Say "Windows has reserved $proto $a-$b for Hyper-V, WSL or Docker. Restart that service: net stop winnat; net start winnat" Red
      }
    }
  }
}
if (-not $left) { Say 'No reservations over 7801-7802.' Green }

# 3. Firewall: the tills, on Private networks
$places = @("$env:LOCALAPPDATA\ShopOS", "$env:LOCALAPPDATA\TRT ShopOS", "$env:LOCALAPPDATA\Programs\ShopOS",
  "$env:ProgramFiles\ShopOS", (Join-Path $PSScriptRoot '..\..\apps\pos\src-tauri\target\tills'))
$exes = $places | Where-Object { Test-Path $_ } |
  ForEach-Object { Get-ChildItem $_ -Recurse -Include 'shopos-pos.exe', 'ShopOS.exe' -ErrorAction SilentlyContinue } |
  Select-Object -ExpandProperty FullName -Unique
Get-NetFirewallRule -Group $Group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
foreach ($exe in $exes) {
  # Any TCP port, since a till that finds 7801 taken listens on another and says so.
  New-NetFirewallRule -Group $Group -DisplayName "ShopOS sync ($exe)" -Direction Inbound -Action Allow `
    -Program $exe -Protocol TCP -Profile Private, Domain | Out-Null
  New-NetFirewallRule -Group $Group -DisplayName "ShopOS find tills ($exe)" -Direction Inbound -Action Allow `
    -Program $exe -Protocol UDP -LocalPort $Hi -Profile Private, Domain | Out-Null
  New-NetFirewallRule -Group $Group -DisplayName "ShopOS closed on public wifi ($exe)" -Direction Inbound -Action Block `
    -Program $exe -Profile Public | Out-Null
  Say "Firewall: $exe allowed on Private networks, blocked on Public." Green
}
if (-not $exes) { Say 'No ShopOS found to let through the firewall. Install it, then run this again.' Yellow }
Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public' | ForEach-Object {
  Say "The network '$($_.Name)' is Public, so tills cannot reach this PC on it. If it is the shop's own wifi: Set-NetConnectionProfile -InterfaceIndex $($_.InterfaceIndex) -NetworkCategory Private" Yellow
}

# 4. The tunnel starts with Windows
$tunnel = Get-Service cloudflared -ErrorAction SilentlyContinue
if ($tunnel) {
  Set-Service cloudflared -StartupType Automatic
  Say "Cloudflare tunnel: starts with Windows (now $($tunnel.Status))." Green
} else {
  Say 'No cloudflared service here. Only the main till needs it.' Gray
}

# 5. The till first
if ($StartTill) {
  if (-not (Test-Path $StartTill)) { Say "No till at $StartTill" Red; exit 1 }
  $link = Join-Path ([Environment]::GetFolderPath('Startup')) 'ShopOS till.lnk'
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
  $s.TargetPath = $StartTill; $s.WorkingDirectory = Split-Path $StartTill; $s.Save()
  Say "Starts at sign-in: $StartTill" Green
}

# 6. Who has the ports now
function Holder($proto, $port) {
  $line = netstat -ano -p $proto | Select-String "^\s*$proto\s+\S+:$port\s" |
    Where-Object { $proto -eq 'UDP' -or $_ -match 'LISTENING' } | Select-Object -First 1
  if (-not $line) { return 'free' }
  $procId = ($line.ToString().Trim() -split '\s+')[-1]
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  "$($p.ProcessName) (pid $procId)"
}
Say ''
Say "7801 TCP: $(Holder 'TCP' 7801)"
Say "7802 UDP: $(Holder 'UDP' 7802)"
Say "7802 TCP: $(Holder 'TCP' 7802)"
Say 'Each should be free or shopos-pos. Anything else: close that program, or ask for the till to use another port.'
