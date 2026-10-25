#!/bin/bash
# ============================================================
#  userdata.sh — EC2 bootstrap (runs once on first boot)
#  Installs: Node.js 20 LTS, Nginx, FFmpeg, Git, 2GB Swap
# ============================================================
set -euxo pipefail
exec > /var/log/userdata.log 2>&1

# ── 1. Create 2GB Swapfile (vital for t3.micro memory stability)
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── 2. System update & tools ──────────────────────────────────
apt-get update -y
apt-get install -y git curl ffmpeg

# ── 3. Node.js 20 LTS ─────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version
npm --version

# ── 4. Install & Enable Nginx ─────────────────────────────────
apt-get install -y nginx
systemctl enable nginx

# ── 5. Web root & app directories ─────────────────────────────
mkdir -p /var/www/clipflip/dist /var/www/clipflip-app
chown -R ubuntu:ubuntu /var/www/clipflip /var/www/clipflip-app

# ── 6. Placeholder HTML until first deploy ────────────────────
cat > /var/www/clipflip/index.html <<'HTML'
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>ClipFlip</title>
<style>body{font-family:sans-serif;background:#040507;color:#f5f7fb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{text-align:center}h1{font-size:2.5rem}p{color:#64748b;margin-top:.5rem}</style>
</head><body><div><h1>⚡ ClipFlip</h1><p>Server initialized. Ready for deployment.</p></div></body></html>
HTML
chown www-data:www-data /var/www/clipflip/index.html

systemctl restart nginx

echo "=== ClipFlip bootstrap complete at $(date) ==="
