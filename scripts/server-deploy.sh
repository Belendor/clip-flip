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
sudo cp index.html "${WEB_ROOT}/index.html"
sudo cp dist/bundle.js "${WEB_ROOT}/dist/bundle.js"
sudo cp dist/output.css "${WEB_ROOT}/dist/output.css"
sudo chown -R www-data:www-data "${WEB_ROOT}"
sudo chmod -R 755 "${WEB_ROOT}"

echo "🌐 [6/6] Updating Nginx configuration and restarting services..."
if [ -f "nginx/clipflip.conf" ]; then
    sudo cp nginx/clipflip.conf /etc/nginx/sites-available/clipflip
    sudo ln -sf /etc/nginx/sites-available/clipflip /etc/nginx/sites-enabled/clipflip
    sudo rm -f /etc/nginx/sites-enabled/default
    sudo nginx -t
    sudo systemctl reload nginx
fi

sudo systemctl restart clipflip-api

echo "✅ Deployment complete! App is live at http://56.228.95.201"
