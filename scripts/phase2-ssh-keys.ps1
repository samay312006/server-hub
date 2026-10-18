# Phase 2: SSH key setup for the interconnected hub.
# The hub server (ssh2) opens SSH sessions FROM this node INTO target devices —
# including loopback (target = self). Key-based auth makes those sessions
# passwordless. Run this on EVERY node (both laptops).
#
#   1. Run with no args first  -> generates this node's keypair, prints its public key,
#                                  and authorizes loopback (self) so target=self works.
#   2. Copy the printed public key to the OTHER node and pass it back here:
#        .\phase2-ssh-keys.ps1 -PeerKeys "ssh-ed25519 AAAA... server-hub@otherbox"
#      (repeat on the other node with this node's key)
#
# Safe to re-run; keys are de-duplicated.

param(
    # One or more peer public keys to authorize for SSH into this machine.
    [string[]]$PeerKeys = @()
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }

$sshDir  = Join-Path $env:USERPROFILE ".ssh"
$keyPath = Join-Path $sshDir "id_ed25519"
$pubPath = "$keyPath.pub"

if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Path $sshDir -Force | Out-Null }

# --- 1. Generate this node's keypair (used by the hub server to log into targets) ---
Write-Step "[1/3] Ensuring this node has an SSH keypair..."
if (Test-Path $keyPath) {
    Write-Host "  Keypair already exists: $keyPath" -ForegroundColor Green
} else {
    # -N "" => no passphrase, so the hub server can use the key non-interactively.
    ssh-keygen -t ed25519 -N '""' -C "server-hub@$env:COMPUTERNAME" -f $keyPath | Out-Null
    Write-Host "  Generated $keyPath" -ForegroundColor Green
}

$myPub = (Get-Content $pubPath -Raw).Trim()

# --- 2. Authorize keys (own key for loopback + any peer keys) into authorized_keys ---
Write-Step "[2/3] Authorizing keys for inbound SSH..."

# Windows OpenSSH: for users in the Administrators group, sshd reads
# C:\ProgramData\ssh\administrators_authorized_keys (NOT the per-user file).
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$keysToAdd = @($myPub) + $PeerKeys | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() }

function Add-AuthorizedKeys($file, $strictAcl) {
    $existing = @()
    if (Test-Path $file) { $existing = Get-Content $file | Where-Object { $_ -and $_.Trim() } }
    $merged = @($existing) + $keysToAdd | Select-Object -Unique
    Set-Content -Path $file -Value $merged -Encoding ascii
    if ($strictAcl) {
        # administrators_authorized_keys must be writable only by SYSTEM + Administrators.
        icacls $file /inheritance:r | Out-Null
        icacls $file /grant "SYSTEM:(F)" | Out-Null
        icacls $file /grant "Administrators:(F)" | Out-Null
    } else {
        icacls $file /inheritance:r | Out-Null
        icacls $file /grant "${env:USERNAME}:(F)" | Out-Null
    }
    Write-Host "  Wrote $($merged.Count) key(s) -> $file" -ForegroundColor Green
}

# Per-user file (used when the SSH login user is a standard user).
Add-AuthorizedKeys (Join-Path $sshDir "authorized_keys") $false

# Admin file (used when the SSH login user is an administrator).
if ($isAdmin) {
    $adminKeys = Join-Path $env:ProgramData "ssh\administrators_authorized_keys"
    Add-AuthorizedKeys $adminKeys $true
    Write-Host "  (You are an admin user, so sshd uses administrators_authorized_keys.)" -ForegroundColor Yellow
}

# --- 3. Report ---
Write-Step "[3/3] This node's public key (copy to the OTHER node):"
Write-Host ""
Write-Host $myPub -ForegroundColor White
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  - On the OTHER laptop, run: .\phase2-ssh-keys.ps1 -PeerKeys `"$myPub`"" -ForegroundColor Gray
Write-Host "  - Then verify from this node:" -ForegroundColor Gray
Write-Host "      ssh $env:USERNAME@127.0.0.1 hostname        # loopback / target=self" -ForegroundColor Gray
Write-Host "      ssh <peerUser>@<peerTailscaleIP> hostname    # into the other laptop" -ForegroundColor Gray
Write-Host "  - Record sshUser/sshPort for each device in webui\devices.json (or the Devices tab)." -ForegroundColor Gray
