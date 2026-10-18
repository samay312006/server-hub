#Requires -RunAsAdministrator
# Phase 1-C: OpenSSH Server - install, harden, set PowerShell as default shell.
# After this runs, connect from any device with: ssh <YourWindowsUsername>@<TailscaleIP>

Write-Host "`n[1/5] Installing OpenSSH Server feature..." -ForegroundColor Cyan
$sshFeature = Get-WindowsCapability -Online -Name OpenSSH.Server*
if ($sshFeature.State -eq "Installed") {
    Write-Host "  Already installed." -ForegroundColor Green
} else {
    Write-Host "  Downloading Win32-OpenSSH from GitHub (bypasses Windows Update)..." -ForegroundColor Yellow
    try {
        $release = Invoke-RestMethod "https://api.github.com/repos/PowerShell/Win32-OpenSSH/releases/latest" -ErrorAction Stop
        $asset = $release.assets | Where-Object { $_.name -like "*Win64.zip" } | Select-Object -First 1
        Write-Host "  Fetching $($asset.name)..." -ForegroundColor Yellow
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile "$env:TEMP\OpenSSH-Win64.zip" -ErrorAction Stop
        Expand-Archive "$env:TEMP\OpenSSH-Win64.zip" -DestinationPath "C:\Program Files\OpenSSH-Win64" -Force
        Push-Location "C:\Program Files\OpenSSH-Win64"
        .\install-sshd.ps1
        Pop-Location
        Write-Host "  Win32-OpenSSH installed." -ForegroundColor Green
    } catch {
        Write-Host "  GitHub download failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  Last resort: Add-WindowsCapability (may be slow)..." -ForegroundColor Yellow
        Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
    }

    # Verify either path actually worked
    $verify = Get-WindowsCapability -Online -Name OpenSSH.Server*
    if ($verify.State -eq "Installed") {
        Write-Host "  Installed successfully." -ForegroundColor Green
    } else {
        Write-Host "  [WARN] OpenSSH still not showing as Installed via capability check." -ForegroundColor Yellow
        Write-Host "         Checking if sshd.exe exists anyway..." -ForegroundColor Yellow
        if (Test-Path "$env:SystemRoot\System32\OpenSSH\sshd.exe") {
            Write-Host "  sshd.exe found - installation OK despite capability report." -ForegroundColor Green
        } else {
            Write-Host "  [ERROR] sshd.exe not found. Manual install required." -ForegroundColor Red
            Write-Host "  Run this in an elevated window then re-run this script:" -ForegroundColor Red
            Write-Host "    winget install Microsoft.OpenSSH.Beta" -ForegroundColor White
            exit 1
        }
    }
}

Write-Host "[2/5] Starting sshd and setting auto-start..." -ForegroundColor Cyan
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
Write-Host "  sshd status: $((Get-Service sshd).Status)" -ForegroundColor Green

Write-Host "[3/5] Setting PowerShell as the default SSH shell..." -ForegroundColor Cyan
$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
$pwshPath = if ($pwshCmd) { $pwshCmd.Source } else { $null }
if (-not $pwshPath) {
    $pwshPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    Write-Host "  pwsh (PS 7) not found, falling back to Windows PowerShell 5.1" -ForegroundColor Yellow
}
$regPath = "HKLM:\SOFTWARE\OpenSSH"
if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
Set-ItemProperty -Path $regPath -Name DefaultShell -Value $pwshPath -Force
Write-Host "  Shell set to: $pwshPath" -ForegroundColor Green

Write-Host "[4/5] Ensuring firewall rule for port 22..." -ForegroundColor Cyan
$rule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
if (-not $rule) {
    New-NetFirewallRule `
        -Name "OpenSSH-Server-In-TCP" `
        -DisplayName "OpenSSH Server (sshd)" `
        -Enabled True -Direction Inbound -Protocol TCP `
        -Action Allow -LocalPort 22 | Out-Null
    Write-Host "  Firewall rule created." -ForegroundColor Green
} else {
    Write-Host "  Firewall rule already exists." -ForegroundColor Green
}

Write-Host "[5/5] Hardening sshd_config..." -ForegroundColor Cyan
$sshdConfig = "$env:ProgramData\ssh\sshd_config"
if (Test-Path $sshdConfig) {
    $cfg = Get-Content $sshdConfig

    # Use multiline regex so ^ matches start of each line, not just start of string
    $cfg = $cfg -join "`n"
    $cfg = $cfg -replace "(?m)^#?PasswordAuthentication\s+\S+", "PasswordAuthentication yes"
    $cfg = $cfg -replace "(?m)^#?PubkeyAuthentication\s+\S+",   "PubkeyAuthentication yes"
    $cfg = $cfg -replace "(?m)^#?PermitRootLogin\s+\S+",        "PermitRootLogin prohibit-password"
    if ($cfg -notmatch "ClientAliveInterval") { $cfg += "`nClientAliveInterval 60" }
    if ($cfg -notmatch "ClientAliveCountMax") { $cfg += "`nClientAliveCountMax 10" }

    # Write without BOM - OpenSSH rejects BOM in sshd_config
    [System.IO.File]::WriteAllText($sshdConfig, $cfg, [System.Text.UTF8Encoding]::new($false))

    try {
        Restart-Service sshd -ErrorAction Stop
        Write-Host "  sshd_config hardened and service restarted." -ForegroundColor Green
    } catch {
        Write-Host "  [WARN] Restart failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  Checking sshd_config for syntax errors..." -ForegroundColor Yellow
        & "$env:ProgramFiles\OpenSSH-Win64\OpenSSH-Win64\sshd.exe" -t 2>&1
        & "C:\Windows\System32\OpenSSH\sshd.exe" -t 2>&1
    }
}

# Generate authorized_keys directory for the current user if it doesn't exist
$sshDir = "$env:USERPROFILE\.ssh"
if (-not (Test-Path $sshDir)) {
    New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
}
$authKeys = "$sshDir\authorized_keys"
if (-not (Test-Path $authKeys)) {
    New-Item -ItemType File -Path $authKeys -Force | Out-Null
    # Lock down permissions (Windows SSH requires strict ACLs)
    icacls $authKeys /inheritance:r | Out-Null
    icacls $authKeys /grant "${env:USERNAME}:(F)" | Out-Null
    Write-Host "  Created $authKeys - paste your client public keys here to enable key auth." -ForegroundColor Yellow
}

Write-Host "`n=== SSH Setup Complete ===" -ForegroundColor Green
Write-Host "  Connect with: ssh $env:USERNAME@<TailscaleIP>" -ForegroundColor White
Write-Host "  Machine hostname : $env:COMPUTERNAME" -ForegroundColor White
Write-Host "  Your Windows username  : $env:USERNAME" -ForegroundColor White
Write-Host "`n  To enable key-based login (recommended):" -ForegroundColor White
Write-Host "    1. On your CLIENT machine run: ssh-keygen -t ed25519 -C server-hub" -ForegroundColor Gray
Write-Host "    2. Copy the contents of id_ed25519.pub into: $authKeys" -ForegroundColor Gray
Write-Host "    3. Set PasswordAuthentication no in sshd_config once keys work." -ForegroundColor Gray
