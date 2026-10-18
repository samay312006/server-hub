#Requires -RunAsAdministrator
# Phase 4: wire up Playwright + WhatsApp MCP and start the WhatsApp daemon.
# Run from an elevated PowerShell. Safe to re-run.

$ErrorActionPreference = "Continue"
$claudeExe = "C:\Users\Samay\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"

Write-Host "`n[1/5] Installing MCP bridge + Playwright deps..." -ForegroundColor Cyan
Set-Location "C:\server-hub\mcp"
npm install --no-fund --no-audit

Write-Host "[2/5] Installing Chromium (headless shell) for the local Playwright..." -ForegroundColor Cyan
node "node_modules\playwright\cli.js" install chromium chromium-headless-shell

Write-Host "[3/5] Registering MCP servers at USER scope (shared by CLI + Web UI)..." -ForegroundColor Cyan
# WhatsApp bridge (no flags -> plain `claude mcp add` works).
$mcpList = & $claudeExe mcp list 2>&1 | Out-String
if ($mcpList -notmatch "whatsapp:") {
    & $claudeExe mcp add whatsapp --scope user -- node "C:\server-hub\mcp\whatsapp-bridge.js"
} else { Write-Host "  whatsapp already registered." -ForegroundColor Green }

# Playwright has flags, which `claude mcp add` mis-parses. Use add-json via the
# native exe (avoids the claude.cmd %* mangling that breaks inline JSON).
if ($mcpList -notmatch "playwright:") {
    $pwJson = '{"type":"stdio","command":"node","args":["C:\\server-hub\\mcp\\node_modules\\@playwright\\mcp\\cli.js","--headless","--isolated"],"env":{}}'
    & $claudeExe mcp add-json playwright $pwJson --scope user
} else { Write-Host "  playwright already registered." -ForegroundColor Green }

Write-Host "  Verifying..." -ForegroundColor Gray
& $claudeExe mcp list 2>&1 | Select-String -Pattern "whatsapp|playwright"

Write-Host "[4/5] Starting the WhatsApp daemon under PM2..." -ForegroundColor Cyan
Write-Host "  NOTE: stop any other running instance of whatsapp-mcp first" -ForegroundColor Yellow
Write-Host "        (only ONE WhatsApp Web session is allowed per login)." -ForegroundColor Yellow
Set-Location "C:\server-hub"
$existing = $null
try { $existing = pm2 jlist 2>$null | ConvertFrom-Json } catch {}
if ($existing | Where-Object { $_.name -eq 'whatsapp-mcp' }) { pm2 delete whatsapp-mcp | Out-Null }
pm2 start ecosystem.config.js --only whatsapp-mcp
pm2 save --force

Write-Host "[5/5] First-time WhatsApp auth (if needed)..." -ForegroundColor Cyan
Write-Host "  If this WhatsApp was never linked here, a QR is saved to:" -ForegroundColor Gray
Write-Host "    C:\Users\Samay\whatsapp-mcp\qr.png" -ForegroundColor White
Write-Host "  Open it and scan with WhatsApp > Linked Devices." -ForegroundColor Gray
Write-Host "  Watch progress: pm2 logs whatsapp-mcp" -ForegroundColor Gray

Write-Host "`n=== Phase 4 wired ===" -ForegroundColor Green
Write-Host "  Test from WhatsApp (message yourself):  /claude what is your model?" -ForegroundColor White
Write-Host "  Test from Web UI:  browse example.com and send a screenshot to my WhatsApp" -ForegroundColor White
