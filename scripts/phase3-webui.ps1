#Requires -RunAsAdministrator
# Phase 3: Deploy the custom Web UI under PM2, scoped to the Tailscale network.
# Safe to re-run.

# Note: NOT "Stop" globally - native tools (pm2, node, curl) write to stderr in
# normal operation, which would wrongly abort the script under Stop.
$ErrorActionPreference = "Continue"
$webuiDir = "C:\server-hub\webui"
$envFile  = "$webuiDir\.env"
$port     = 8088

Write-Host "`n[1/5] Generating .env with a login password..." -ForegroundColor Cyan
if (Test-Path $envFile) {
    Write-Host "  .env already exists - keeping it (delete it to regenerate)." -ForegroundColor Green
    $existing = Get-Content $envFile | Where-Object { $_ -match "^HUB_PASSWORD=" }
    if ($existing) { Write-Host "  Current $existing" -ForegroundColor Gray }
} else {
    # Generate a readable random password (12 chars, no ambiguous look-alikes).
    $chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789".ToCharArray()
    $pw = -join (1..12 | ForEach-Object { $chars | Get-Random })
    @(
        "HUB_PORT=$port",
        "HUB_BIND=0.0.0.0",
        "HUB_PASSWORD=$pw",
        "HUB_MODEL=opus",
        "HUB_WORKDIR=C:\server-hub",
        "HUB_PERMISSION_MODE=bypassPermissions",
        "HUB_TURN_TIMEOUT_MS=600000"
    ) | Set-Content $envFile -Encoding ascii
    Write-Host "  Created $envFile" -ForegroundColor Green
    Write-Host "  ==> WEB UI PASSWORD: $pw" -ForegroundColor Yellow
}

Write-Host "[2/5] Firewall: allow port $port ONLY from the Tailscale network..." -ForegroundColor Cyan
# 100.64.0.0/10 is the Tailscale (CGNAT) address range. This blocks the local LAN
# and the public internet while permitting any device on your tailnet.
$ruleName = "ServerHub-WebUI-Tailscale"
Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule `
    -Name $ruleName `
    -DisplayName "Server Hub Web UI (Tailscale only)" `
    -Direction Inbound -Protocol TCP -LocalPort $port `
    -RemoteAddress 100.64.0.0/10 `
    -Action Allow -Enabled True | Out-Null
Write-Host "  Firewall scoped to 100.64.0.0/10 (tailnet only)." -ForegroundColor Green

Write-Host "[3/5] Quick smoke test of server.js..." -ForegroundColor Cyan
Push-Location $webuiDir
$test = Start-Process node -ArgumentList "server.js" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
try {
    $resp = Invoke-RestMethod "http://127.0.0.1:$port/healthz" -TimeoutSec 5
    if ($resp.ok) { Write-Host "  Health check OK." -ForegroundColor Green }
} catch {
    Write-Host "  [WARN] Health check failed: $($_.Exception.Message)" -ForegroundColor Yellow
} finally {
    Stop-Process -Id $test.Id -Force -ErrorAction SilentlyContinue
}
Pop-Location

Write-Host "[4/5] Registering with PM2..." -ForegroundColor Cyan
Set-Location "C:\server-hub"
# Delete any existing instance only if present (avoids a noisy error on first run).
$existing = $null
try { $existing = pm2 jlist 2>$null | ConvertFrom-Json } catch {}
if ($existing | Where-Object { $_.name -eq 'hub-webui' }) {
    pm2 delete hub-webui | Out-Null
}
pm2 start ecosystem.config.js --only hub-webui
pm2 save --force

Write-Host "[5/5] Done." -ForegroundColor Cyan
Write-Host "`n=== Web UI live ===" -ForegroundColor Green
Write-Host "  From any device on your tailnet, open:" -ForegroundColor White
$tsIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like "100.*" } | Select-Object -First 1 -ExpandProperty IPAddress)
  if (-not $tsIp) { $tsIp = "<tailscale-ip>" }
  Write-Host "    http://${tsIp}:$port" -ForegroundColor White
Write-Host "  Log in with the password above (also stored in $envFile)." -ForegroundColor Gray
Write-Host "  Logs: pm2 logs hub-webui   |   Status: pm2 list" -ForegroundColor Gray

