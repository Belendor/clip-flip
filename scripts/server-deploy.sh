#!/bin/bash
# ============================================================
#  server-deploy.sh — ClipFlip automated deployment on EC2
# ============================================================
set -euo pipefail

APP_DIR="/home/ubuntu/clip-flip"
WEB_ROOT="/var/www/clipflip"

echo "🚀 [1/6] Pulling latest code from GitHub..."
cd "$APP_DIR"
git fetch origin main
git reset --hard origin/main

echo "📦 [2/6] Installing npm dependencies..."
npm install --prefer-offline

echo "🗄️  [3/6] Syncing Prisma database schema..."
npx prisma db push --skip-generate
npx prisma generate

echo "⚙️  [4/6] Building Webpack bundle and Tailwind CSS..."
npm run build:prod
npm run build:css

echo "📁 [5/6] Deploying frontend assets to ${WEB_ROOT}..."
sudo mkdir -p "${WEB_ROOT}/dist"
sudo mkdir -p "${WEB_ROOT}/video"
sudo mkdir -p "${WEB_ROOT}/video1/new/thumbnails"
sudo mkdir -p "${WEB_ROOT}/thumbnails"
mkdir -p "${APP_DIR}/storage/temp/videos"

# Ensure APP_DIR symlinks point to WEB_ROOT storage directories
if [ -d "${APP_DIR}/video" ] && [ ! -L "${APP_DIR}/video" ]; then
    sudo cp -rn "${APP_DIR}/video/"* "${WEB_ROOT}/video/" 2>/dev/null || true
    rm -rf "${APP_DIR}/video"
fi
ln -sfn "${WEB_ROOT}/video" "${APP_DIR}/video"

if [ -d "${APP_DIR}/video1" ] && [ ! -L "${APP_DIR}/video1" ]; then
    sudo cp -rn "${APP_DIR}/video1/"* "${WEB_ROOT}/video1/" 2>/dev/null || true
    rm -rf "${APP_DIR}/video1"
fi
ln -sfn "${WEB_ROOT}/video1" "${APP_DIR}/video1"

if [ -d "${APP_DIR}/thumbnails" ] && [ ! -L "${APP_DIR}/thumbnails" ]; then
    sudo cp -rn "${APP_DIR}/thumbnails/"* "${WEB_ROOT}/thumbnails/" 2>/dev/null || true
    rm -rf "${APP_DIR}/thumbnails"
fi
ln -sfn "${WEB_ROOT}/thumbnails" "${APP_DIR}/thumbnails"

sudo cp index.html "${WEB_ROOT}/index.html"
sudo cp dist/bundle.js "${WEB_ROOT}/dist/bundle.js"
sudo cp dist/output.css "${WEB_ROOT}/dist/output.css"

sudo usermod -a -G www-data ubuntu || true
sudo chown -R www-data:www-data "${WEB_ROOT}"
sudo chmod -R 775 "${WEB_ROOT}"

echo "🌐 [6/6] Updating Nginx configuration and restarting services..."
if [ -f "nginx/clipflip.conf" ]; then
    sudo cp nginx/clipflip.conf /etc/nginx/sites-available/clipflip
    # If Certbot SSL certificate exists, re-install it into Nginx so deploy never wipes HTTPS
    if [ -f "/etc/letsencrypt/live/clip-flip.com/fullchain.pem" ] && command -v certbot >/dev/null 2>&1; then
        echo "🔒 SSL certificate detected for clip-flip.com. Ensuring HTTPS is active..."
        sudo certbot install --nginx -d clip-flip.com -d www.clip-flip.com --non-interactive || true
    fi
    sudo ln -sf /etc/nginx/sites-available/clipflip /etc/nginx/sites-enabled/clipflip
    sudo rm -f /etc/nginx/sites-enabled/default
    sudo nginx -t
    sudo systemctl reload nginx
fi

sudo fuser -k 3000/tcp || true
sudo systemctl restart clipflip-api

echo "✅ Deployment complete! App is live at http://56.228.95.201"
