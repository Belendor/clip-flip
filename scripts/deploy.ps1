# ============================================================
#  deploy.ps1 — 1-Click Deployment to AWS EC2
#  Usage: .\scripts\deploy.ps1
# ============================================================

$ErrorActionPreference = "Stop"

$EC2_IP = "56.228.95.201"
$SSH_KEY = Join-Path $PSScriptRoot "..\ClipFlipkey.pem"

if (-not (Test-Path $SSH_KEY)) {
    $SSH_KEY = Join-Path $env:USERPROFILE "Downloads\ClipFlipkey.pem"
}

if (-not (Test-Path $SSH_KEY)) {
    Write-Error "Could not find ClipFlipkey.pem at root or in Downloads folder."
    exit 1
}

Write-Host "[1/3] Pushing latest changes to GitHub..." -ForegroundColor Cyan
git push origin main

Write-Host "[2/3] Connecting to EC2 ($EC2_IP) and executing deployment..." -ForegroundColor Cyan
$remoteCmd = "cd /home/ubuntu/clip-flip; git pull origin main; chmod +x scripts/server-deploy.sh; bash scripts/server-deploy.sh"
ssh -o StrictHostKeyChecking=no -i $SSH_KEY ubuntu@$EC2_IP $remoteCmd

Write-Host "[3/3] Successfully deployed! Live at http://$EC2_IP" -ForegroundColor Green
