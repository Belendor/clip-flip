# ============================================================
#  deploy.ps1 — 1-Click Deployment to AWS EC2
#  Usage: .\scripts\deploy.ps1
# ============================================================

$ErrorActionPreference = "Stop"

$EC2_IP = "56.228.95.201"
$SSH_KEY = "$PSScriptRoot\..\ClipFlipkey.pem"

if (-not (Test-Path $SSH_KEY)) {
    # Check Downloads folder as fallback
    $SSH_KEY = "$env:USERPROFILE\Downloads\ClipFlipkey.pem"
}

if (-not (Test-Path $SSH_KEY)) {
    Write-Error "Could not find ClipFlipkey.pem at root or in Downloads folder."
}

Write-Host "📡 Pushing latest changes to GitHub..." -ForegroundColor Cyan
git push origin main

Write-Host "🚀 Triggering deployment on EC2 ($EC2_IP)..." -ForegroundColor Cyan
ssh -o StrictHostKeyChecking=no -i $SSH_KEY ubuntu@$EC2_IP "chmod +x /home/ubuntu/clip-flip/scripts/server-deploy.sh && /home/ubuntu/clip-flip/scripts/server-deploy.sh"

Write-Host "🎉 Successfully deployed! Check http://$EC2_IP" -ForegroundColor Green
