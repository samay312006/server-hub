#Requires -RunAsAdministrator
# Phase 1-D: Install PM2 and configure Windows auto-start.
# PM2 will manage all long-running processes (Web UI, MCP servers, etc.) in later phases.

Write-Host "`n[1/4] Installing PM2 globally..." -ForegroundColor Cyan
npm install -g pm2
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed. Ensure Node.js is installed first."; exit 1 }

Write-Host "[2/4] Installing pm2-windows-startup (Windows service bridge)..." -ForegroundColor Cyan
npm install -g pm2-windows-startup
pm2-startup install

Write-Host "[3/4] Creating a placeholder PM2 ecosystem config at C:\server-hub\ecosystem.config.js..." -ForegroundColor Cyan
$ecosystemPath = "C:\server-hub\ecosystem.config.js"
if (-not (Test-Path $ecosystemPath)) {
@'
// PM2 ecosystem - add MCP servers and Web UI here in later phases.
// Start all: pm2 start ecosystem.config.js
// Save state: pm2 save
// Monitor:    pm2 monit
module.exports = {
  apps: [
    // Phase 4 entries (WhatsApp MCP, Playwright MCP, Web UI) go here.
    // Example placeholder - remove before Phase 4:
    // {
    //   name: 'whatsapp-mcp',
    //   script: 'C:/Users/Samay/whatsapp-mcp/build/index.js',
    //   watch: false,
    //   max_memory_restart: '300M',
    //   env: { NODE_ENV: 'production' }
    // }
  ]
}
'@ | Set-Content $ecosystemPath -Encoding utf8
    Write-Host "  Created $ecosystemPath" -ForegroundColor Green
}

Write-Host "[4/4] Saving PM2 state (so it restores on reboot)..." -ForegroundColor Cyan
pm2 save --force

Write-Host "`n[OK] PM2 ready. Commands reference:" -ForegroundColor Green
Write-Host "  pm2 list          - see all processes" -ForegroundColor Gray
Write-Host "  pm2 start <name>  - start a process" -ForegroundColor Gray
Write-Host "  pm2 logs <name>   - tail logs" -ForegroundColor Gray
Write-Host "  pm2 monit         - live RAM/CPU dashboard" -ForegroundColor Gray
Write-Host "  pm2 save          - persist current list across reboots" -ForegroundColor Gray
