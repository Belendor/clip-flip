#!/bin/bash
# ============================================================
#  userdata.sh — EC2 bootstrap script
#  Runs once on first boot as root.
#  Installs: Nginx, Java 17, Jenkins (via WAR — no broken repo)
# ============================================================
set -euxo pipefail
exec > /var/log/userdata.log 2>&1

# ── System update ─────────────────────────────────────────────
apt-get update -y
apt-get upgrade -y
apt-get install -y git curl fontconfig openjdk-17-jre

# ── Install Nginx ─────────────────────────────────────────────
apt-get install -y nginx
systemctl enable nginx

# ── Create web root ──────────────────────────────────────────
mkdir -p /var/www/clipflip/src
chown -R www-data:www-data /var/www/clipflip

# ── Nginx site config ─────────────────────────────────────────
cat > /etc/nginx/sites-available/clipflip <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    root /var/www/clipflip;
    index index.html;
    server_name _;

    location / {
        try_files $uri $uri/ /index.html;
    }

    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";

    location ~* \.(css|js|ico|png|jpg|jpeg|svg|woff2)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
NGINX

ln -sf /etc/nginx/sites-available/clipflip /etc/nginx/sites-enabled/clipflip
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# ── Placeholder page (shown until first CI/CD deploy) ─────────
cat > /var/www/clipflip/index.html <<'HTML'
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>ClipFlip</title>
<style>body{font-family:sans-serif;background:#0a0a12;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{text-align:center}h1{font-size:2.5rem;margin-bottom:.5rem}p{color:#64748b}</style>
</head><body><div><h1>⚡ ClipFlip</h1><p>Setting up... first deploy coming soon.</p></div></body></html>
HTML
chown www-data:www-data /var/www/clipflip/index.html

# ── Jenkins — create user + dirs ──────────────────────────────
useradd -r -m -U -d /var/lib/jenkins -s /bin/bash jenkins 2>/dev/null || true
mkdir -p /usr/share/jenkins /var/lib/jenkins /var/log/jenkins /var/cache/jenkins
chown -R jenkins:jenkins /usr/share/jenkins /var/lib/jenkins /var/log/jenkins /var/cache/jenkins

# ── Jenkins — download LTS WAR (no broken apt repo needed) ────
curl -fsSL -o /usr/share/jenkins/jenkins.war \
  https://get.jenkins.io/war-stable/2.504.1/jenkins.war

# ── Jenkins — systemd service ─────────────────────────────────
cat > /etc/systemd/system/jenkins.service <<'SVC'
[Unit]
Description=Jenkins Continuous Integration Server
After=network.target

[Service]
Type=simple
User=jenkins
Environment="JENKINS_HOME=/var/lib/jenkins"
ExecStart=/usr/bin/java -jar /usr/share/jenkins/jenkins.war --httpPort=8080 --webroot=/var/cache/jenkins/war
Restart=on-failure
RestartSec=10
StandardOutput=append:/var/log/jenkins/jenkins.log
StandardError=append:/var/log/jenkins/jenkins.log

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable jenkins
systemctl start jenkins

# ── Sudoers — Jenkins can deploy without password prompt ──────
cat > /etc/sudoers.d/jenkins-nginx <<'SUDOERS'
jenkins ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx, /usr/bin/systemctl restart nginx, /bin/cp, /bin/rm, /bin/mkdir, /bin/chown, /bin/chmod
SUDOERS
chmod 440 /etc/sudoers.d/jenkins-nginx

echo "=== ClipFlip bootstrap complete at $(date) ==="
