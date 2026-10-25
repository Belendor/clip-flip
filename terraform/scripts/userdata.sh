#!/bin/bash
# ============================================================
#  userdata.sh — EC2 bootstrap (runs once on first boot)
#  Installs: Node.js 20, Nginx, Java 17, Jenkins WAR
# ============================================================
set -euxo pipefail
exec > /var/log/userdata.log 2>&1

# ── System update ─────────────────────────────────────────────
apt-get update -y
apt-get upgrade -y
apt-get install -y git curl fontconfig openjdk-17-jre

# ── Node.js 20 LTS (needed for Jenkins build steps) ──────────
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version
npm --version

# ── Install Nginx ─────────────────────────────────────────────
apt-get install -y nginx
systemctl enable nginx

# ── Web root ──────────────────────────────────────────────────
mkdir -p /var/www/clipflip/dist
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

    # Cache built assets (bundle.js, output.css) aggressively
    location ~* \.(css|js|ico|png|jpg|jpeg|svg|woff2|mp4)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
NGINX

ln -sf /etc/nginx/sites-available/clipflip /etc/nginx/sites-enabled/clipflip
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# ── Placeholder page until first CI/CD deploy ─────────────────
cat > /var/www/clipflip/index.html <<'HTML'
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>ClipFlip</title>
<style>body{font-family:sans-serif;background:#040507;color:#f5f7fb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{text-align:center}h1{font-size:2.5rem}p{color:#64748b;margin-top:.5rem}</style>
</head><body><div><h1>⚡ ClipFlip</h1><p>Jenkins is building... first deploy soon.</p></div></body></html>
HTML
chown www-data:www-data /var/www/clipflip/index.html

# ── Jenkins — user + dirs ─────────────────────────────────────
useradd -r -m -U -d /var/lib/jenkins -s /bin/bash jenkins 2>/dev/null || true
mkdir -p /usr/share/jenkins /var/lib/jenkins /var/log/jenkins /var/cache/jenkins
chown -R jenkins:jenkins /usr/share/jenkins /var/lib/jenkins /var/log/jenkins /var/cache/jenkins

# ── Jenkins — download LTS WAR ────────────────────────────────
curl -fsSL -o /usr/share/jenkins/jenkins.war \
  https://get.jenkins.io/war-stable/2.504.1/jenkins.war

# ── Jenkins — systemd service ─────────────────────────────────
cat > /etc/systemd/system/jenkins.service <<'SVC'
[Unit]
Description=Jenkins CI Server
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

# ── Sudoers — Jenkins can deploy without password ─────────────
cat > /etc/sudoers.d/jenkins-nginx <<'SUDOERS'
jenkins ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx, /usr/bin/systemctl restart nginx, /usr/sbin/nginx, /bin/cp, /bin/rm, /bin/mkdir, /bin/chown, /bin/chmod, /bin/ln
SUDOERS
chmod 440 /etc/sudoers.d/jenkins-nginx

echo "=== ClipFlip bootstrap complete at $(date) ==="
