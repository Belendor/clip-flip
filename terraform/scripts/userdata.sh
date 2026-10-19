#!/bin/bash
# ============================================================
#  userdata.sh — EC2 bootstrap script
#  Runs once on first boot as root.
#  Installs: Nginx, Java 17, Jenkins
#  Configures: Nginx to serve /var/www/clipflip
#              Jenkins on port 8080
# ============================================================
set -euxo pipefail
exec > /var/log/userdata.log 2>&1

# ── System update ────────────────────────────────────────────
apt-get update -y
apt-get upgrade -y

# ── Install Nginx ────────────────────────────────────────────
apt-get install -y nginx
systemctl enable nginx

# ── Create web root for ClipFlip ────────────────────────────
mkdir -p /var/www/clipflip
chown -R www-data:www-data /var/www/clipflip

# ── Nginx site config ────────────────────────────────────────
cat > /etc/nginx/sites-available/clipflip <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    root /var/www/clipflip;
    index index.html;

    server_name _;

    # Serve static files; 404 falls back to index.html (SPA-friendly)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";
    add_header Referrer-Policy "strict-origin-when-cross-origin";

    # Cache static assets
    location ~* \.(css|js|ico|png|jpg|jpeg|svg|woff2)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
NGINX

# Enable site and remove default
ln -sf /etc/nginx/sites-available/clipflip /etc/nginx/sites-enabled/clipflip
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# ── Install Java 17 (required by Jenkins) ───────────────────
apt-get install -y fontconfig openjdk-17-jre

# ── Install Jenkins ──────────────────────────────────────────
curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2023.key \
  | tee /usr/share/keyrings/jenkins-keyring.asc > /dev/null

echo "deb [signed-by=/usr/share/keyrings/jenkins-keyring.asc] \
  https://pkg.jenkins.io/debian-stable binary/" \
  | tee /etc/apt/sources.list.d/jenkins.list > /dev/null

apt-get update -y
apt-get install -y jenkins

systemctl enable jenkins
systemctl start jenkins

# ── Allow Jenkins user to restart Nginx without sudo password ─
echo "jenkins ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx, /usr/bin/systemctl restart nginx, /bin/cp, /bin/rm, /bin/mkdir, /bin/chown, /bin/chmod" \
  >> /etc/sudoers.d/jenkins-nginx
chmod 440 /etc/sudoers.d/jenkins-nginx

# ── Install Git (for Jenkins to clone repo) ──────────────────
apt-get install -y git

# ── Put a placeholder page up immediately ───────────────────
cat > /var/www/clipflip/index.html <<'HTML'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ClipFlip — Setting Up</title>
  <style>
    body { font-family: sans-serif; background: #0a0a12; color: #f1f5f9;
           display:flex; align-items:center; justify-content:center; min-height:100vh; }
    h1 { font-size: 2rem; }
    p  { color: #64748b; }
  </style>
</head>
<body>
  <div style="text-align:center">
    <h1>⚡ ClipFlip</h1>
    <p>Jenkins is warming up. First deploy coming soon...</p>
  </div>
</body>
</html>
HTML

chown www-data:www-data /var/www/clipflip/index.html

# ── Done ─────────────────────────────────────────────────────
echo "=== ClipFlip bootstrap complete at $(date) ==="
