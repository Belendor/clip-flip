# ============================================================
#  dev.ps1 — 1-Click Fast Local Dev Launcher for ClipFlip
#  Media (videos, thumbnails) is streamed directly from prod EC2
#  Usage: .\scripts\dev.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

Write-Host "`n⚡ ClipFlip Local Development Environment" -ForegroundColor Cyan

# 1. Check node_modules
if (-not (Test-Path "node_modules")) {
    Write-Host "📦 Installing local dependencies (first-time setup)..." -ForegroundColor Yellow
    npm install
}

# 2. Check local sqlite database
if (-not (Test-Path "prisma\dev.db")) {
    $SSH_KEY = Join-Path $root "ClipFlipkey.pem"
    if (-not (Test-Path $SSH_KEY)) {
        $SSH_KEY = Join-Path $env:USERPROFILE "Downloads\ClipFlipkey.pem"
    }

    if (Test-Path $SSH_KEY) {
        Write-Host "🗄️  Syncing dev.db from production EC2 server..." -ForegroundColor Cyan
        try {
            scp -o StrictHostKeyChecking=no -i $SSH_KEY ubuntu@56.228.95.201:/home/ubuntu/clip-flip/prisma/dev.db prisma\dev.db
        } catch {
            Write-Host "⚠️  Could not scp database, creating new local database via Prisma push..." -ForegroundColor Yellow
            npx prisma db push --skip-generate
        }
    } else {
        Write-Host "🗄️  Creating local database via Prisma push..." -ForegroundColor Yellow
        npx prisma db push --skip-generate
    }
}

# 3. Prisma client
if (-not (Test-Path "node_modules\.prisma\client")) {
    Write-Host "⚙️  Generating Prisma client..." -ForegroundColor Cyan
    npx prisma generate
}

# 4. Build bundle & CSS if missing
if (-not (Test-Path "dist\bundle.js") -or -not (Test-Path "dist\output.css")) {
    Write-Host "🔨 Compiling assets..." -ForegroundColor Cyan
    npm run build:prod
    npm run build:css
}

Write-Host "`n🚀 Launching services:" -ForegroundColor Green
Write-Host "   • Local Frontend: http://localhost:8080" -ForegroundColor White
Write-Host "   • Local API Server: http://localhost:3000" -ForegroundColor White
Write-Host "   • Videos & Thumbnails: Streamed directly from Prod (http://56.228.95.201)" -ForegroundColor Yellow
Write-Host "   • Auto-reload & file watching: ENABLED" -ForegroundColor Cyan
Write-Host "   • Press Ctrl+C in this terminal to stop everything.`n" -ForegroundColor DarkGray

npm run dev:all
