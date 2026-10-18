#Requires -RunAsAdministrator
<#
  server-hub one-shot setup. Run from an ELEVATED PowerShell:
      C:\server-hub\scripts\setup.ps1

  Prerequisites (do these first - they can't be scripted):
    1. Claude Code installed AND logged in:  claude  (then /login)
    2. This repo cloned to C:\server-hub  (or anywhere; paths auto-resolve)
    3. Internet access.

  What it does: Phase 1 base (power/Node/Python/Git/OpenSSH/PM2), app deps,
  Playwright browser, MCP registration, Web UI + WhatsApp configs, then starts
  the services under PM2. Safe to re-run (idempotent).

  Still manual after this (the script tells you when):
    - Tailscale login,  WhatsApp QR scan,  Groq API key.
#>

$ErrorActionPreference = "Continue"
$ROOT = Split-Path $PSScriptRoot -Parent           # repo root
$claudeExe = Join-Path $env:APPDATA "npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path","User")
}
function Section($n) { Write-Host "`n=== $n ===" -ForegroundColor Cyan }

# ── Phase 1: Windows base ───────────────────────────────────────────────────────
Section "Phase 1: Windows base (power, Node, Python, Git, OpenSSH, PM2)"
& "$PSScriptRoot\phase1-optimize.ps1"
& "$PSScriptRoot\phase1-install.ps1"
Refresh-Path
& "$PSScriptRoot\phase1-ssh.ps1"
& "$PSScriptRoot\phase1-pm2.ps1"
Refresh-Path

# ── Tailscale ───────────────────────────────────────────────────────────────────
Section "Tailscale"
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
  winget install Tailscale.Tailscale --silent --accept-package-agreements --accept-source-agreements
  Refresh-Path
}
Write-Host "  After setup finishes, run:  tailscale up   (and log in via the browser)." -ForegroundColor Yellow

# ── App dependencies ────────────────────────────────────────────────────────────
Section "Installing app dependencies"
Push-Location "$ROOT\mcp";          npm install --no-fund --no-audit; Pop-Location
Push-Location "$ROOT\whatsapp-mcp"; npm install --no-fund --no-audit; Pop-Location
Write-Host "  Installing Chromium for Playwright (headless shell)..." -ForegroundColor Gray
Push-Location "$ROOT\mcp"; node "node_modules\playwright\cli.js" install chromium chromium-headless-shell; Pop-Location

# ── Register MCP servers (user scope -> shared by CLI + Web UI) ──────────────────
Section "Registering MCP servers"
if (-not (Test-Path $claudeExe)) {
  Write-Host "  [WARN] claude.exe not found at $claudeExe - is Claude Code installed?" -ForegroundColor Yellow
} else {
  $list = & $claudeExe mcp list 2>&1 | Out-String
  if ($list -notmatch "whatsapp:") {
    & $claudeExe mcp add whatsapp --scope user -- node "$ROOT\mcp\whatsapp-bridge.js"
  }
  if ($list -notmatch "playwright:") {
    $pwCli = "$ROOT\mcp\node_modules\@playwright\mcp\cli.js" -replace '\\','\\'
    $json = '{"type":"stdio","command":"node","args":["' + $pwCli + '","--headless","--isolated"],"env":{}}'
    & $claudeExe mcp add-json playwright $json --scope user
  }
  & $claudeExe mcp list 2>&1 | Select-String -Pattern "whatsapp|playwright"
}

# ── WhatsApp daemon .env (API key for the incoming chatbot) ──────────────────────
Section "WhatsApp .env"
$waEnv = "$ROOT\whatsapp-mcp\.env"
if (-not (Test-Path $waEnv)) {
  Copy-Item "$ROOT\whatsapp-mcp\.env.example" $waEnv -Force
  Write-Host "  Created $waEnv - add your GROQ_API_KEY (free: console.groq.com/keys)" -ForegroundColor Yellow
  Write-Host "  (incoming /claude chatbot stays off until a key is set; your own /claude works regardless)" -ForegroundColor Gray
}

# ── Web UI .env + firewall (Tailscale-only) ─────────────────────────────────────
Section "Web UI"
& "$PSScriptRoot\phase3-webui.ps1"   # generates webui\.env + password, firewall, starts hub-webui

# ── Start the WhatsApp daemon ───────────────────────────────────────────────────
Section "Starting WhatsApp daemon"
Set-Location $ROOT
$existing = $null
try { $existing = pm2 jlist 2>$null | ConvertFrom-Json } catch {}
if ($existing | Where-Object { $_.name -eq 'whatsapp-mcp' }) { pm2 delete whatsapp-mcp | Out-Null }
pm2 start ecosystem.config.js --only whatsapp-mcp
pm2 save --force

# ── Done ────────────────────────────────────────────────────────────────────────
Section "Setup complete"
Write-Host "  Remaining manual steps:" -ForegroundColor White
Write-Host "   1. tailscale up   (log in)" -ForegroundColor Gray
Write-Host "   2. pm2 logs whatsapp-mcp   -> scan whatsapp-mcp\qr.png with WhatsApp > Linked Devices" -ForegroundColor Gray
Write-Host "   3. Add GROQ_API_KEY to whatsapp-mcp\.env, then: pm2 restart whatsapp-mcp" -ForegroundColor Gray
Write-Host "  Web UI password was printed above. Reach it at http://<your-tailscale-ip>:8088" -ForegroundColor White
Write-Host "  Get your Tailscale IP with:  tailscale ip -4" -ForegroundColor Gray
