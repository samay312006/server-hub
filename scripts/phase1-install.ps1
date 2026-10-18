#Requires -RunAsAdministrator
# Phase 1-B: Core Toolchain Installation
# Installs Node.js LTS, Python 3.12, Git, Windows Terminal via winget.
# Safe to re-run -- winget skips already-installed packages.

function Install-Tool {
    param($id, $label)
    Write-Host "  Installing $label..." -ForegroundColor Cyan
    $result = winget install --id $id --silent --accept-package-agreements --accept-source-agreements 2>&1
    if ($LASTEXITCODE -eq 0 -or $result -match "already installed") {
        Write-Host "  [OK] $label" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] $label may need manual install. winget output:" -ForegroundColor Yellow
        Write-Host $result
    }
}

Write-Host "`n[Phase 1-B] Installing core toolchain`n" -ForegroundColor White

Install-Tool "OpenJS.NodeJS.LTS"         "Node.js LTS"
Install-Tool "Python.Python.3.12"        "Python 3.12"
Install-Tool "Git.Git"                   "Git"
Install-Tool "Microsoft.WindowsTerminal" "Windows Terminal"

Write-Host "`nRefreshing PATH in current session..." -ForegroundColor Cyan
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host "`n--- Version Check ---" -ForegroundColor White
$tools = @{
    "node"   = "Node.js"
    "npm"    = "npm"
    "python" = "Python"
    "git"    = "Git"
}
foreach ($cmd in $tools.Keys) {
    try {
        $ver = & $cmd --version 2>&1
        Write-Host "  $($tools[$cmd]): $ver" -ForegroundColor Green
    } catch {
        Write-Host "  $($tools[$cmd]): NOT FOUND (may need new terminal session)" -ForegroundColor Yellow
    }
}

Write-Host "`n--- Post-install hardening ---" -ForegroundColor White

# Upgrade pip without interaction
python -m pip install --upgrade pip --quiet

# npm: disable telemetry, set cache to keep it off C: system dirs
npm config set fund false
npm config set audit false
npm config set loglevel warn

# Python: add Scripts to PATH if missing
$pyScripts = (python -c "import sysconfig; print(sysconfig.get_path('scripts'))" 2>&1).Trim()
$machinePath = [System.Environment]::GetEnvironmentVariable("Path","Machine")
if ($pyScripts -and $machinePath -notlike "*$pyScripts*") {
    [System.Environment]::SetEnvironmentVariable(
        "Path", "$machinePath;$pyScripts", "Machine"
    )
    Write-Host "  Added Python Scripts to system PATH: $pyScripts" -ForegroundColor Green
}

Write-Host "`n[OK] Phase 1-B complete. Open a NEW terminal to pick up PATH changes." -ForegroundColor Green
