#Requires -RunAsAdministrator
# Phase 1-A: Windows 11 Server Optimization
# Run once from an elevated PowerShell prompt.

Write-Host "`n[1/6] Activating High Performance power plan..." -ForegroundColor Cyan

# Activate built-in High Performance scheme
$hp = powercfg /l | Select-String "High performance" | ForEach-Object { ($_ -split '\s+')[3] }
if ($hp) {
    powercfg /setactive $hp
} else {
    # Duplicate Balanced and make our own if HP is missing (common on IdeaPads)
    $newScheme = (powercfg /duplicatescheme 381b4222-f694-41f0-9685-ff5bb260df2e) -match '[0-9a-f]{8}-[0-9a-f]{4}' | Out-Null
    powercfg /changename SCHEME_CURRENT "Server-Max" "Optimized for always-on server use"
    powercfg /setactive SCHEME_CURRENT
}

Write-Host "[2/6] Disabling sleep, hibernation, and monitor timeout..." -ForegroundColor Cyan
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
powercfg /h off   # disable hibernation file entirely (~1.5GB freed)

Write-Host "[3/6] Setting lid-close action to 'Do Nothing' (AC + DC)..." -ForegroundColor Cyan
# Sub-group: Power buttons and lid | Setting: Lid close action
$lidSubgroup = "4f971e89-eebd-4455-a8de-9e59040e7347"
$lidSetting  = "5ca83367-6e45-459f-a27b-476b1d01c936"
powercfg /SETACVALUEINDEX SCHEME_CURRENT $lidSubgroup $lidSetting 000
powercfg /SETDCVALUEINDEX SCHEME_CURRENT $lidSubgroup $lidSetting 000
powercfg /SETACTIVE SCHEME_CURRENT

Write-Host "[4/6] Disabling CPU Power Throttling (keeps i5 from soft-throttling)..." -ForegroundColor Cyan
$throttlePath = "HKLM:\SYSTEM\CurrentControlSet\Control\Power\PowerThrottling"
if (-not (Test-Path $throttlePath)) { New-Item -Path $throttlePath -Force | Out-Null }
Set-ItemProperty -Path $throttlePath -Name PowerThrottlingOff -Value 1 -Type DWord -Force

Write-Host "[5/6] Stripping visual effects (frees ~50-80 MB RAM)..." -ForegroundColor Cyan
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects" `
    -Name VisualFXSetting -Value 2 -Type DWord -Force

Write-Host "[6/6] Disabling high-RAM startup bloat..." -ForegroundColor Cyan
$disableStartup = @(
    "MicrosoftEdgeAutoLaunch*",
    "OneDrive",
    "Teams",
    "Spotify*",
    "Discord*",
    "Cortana"
)
foreach ($app in $disableStartup) {
    Get-ScheduledTask -TaskName $app -ErrorAction SilentlyContinue |
        Disable-ScheduledTask -ErrorAction SilentlyContinue | Out-Null
}
# Also hit the Run key
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
@("OneDrive","Teams","Spotify","Discord") | ForEach-Object {
    Remove-ItemProperty -Path $runKey -Name $_ -ErrorAction SilentlyContinue
}

Write-Host "`n[OK] Phase 1-A complete. Reboot to apply power + visual changes." -ForegroundColor Green
Write-Host "     Lid close = Do Nothing | Sleep = Off | Hibernation = Off | Power Throttling = Off" -ForegroundColor Gray
