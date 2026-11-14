#!/usr/bin/env bash
# ==============================================================================
# ClipFlip Dedicated Video Processing & Crawler EC2 Worker Setup Script
# Run this on a new Ubuntu 22.04 / 24.04 EC2 instance to configure the crawler worker.
# ==============================================================================

set -e

echo "🚀 [1/5] Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

echo "📦 [2/5] Installing FFmpeg, Git, curl, build tools..."
sudo apt-get install -y ffmpeg git curl build-essential

echo "📦 [3/5] Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "🔍 Node version: $(node -v)"
echo "🔍 NPM version: $(npm -v)"
echo "🔍 FFmpeg version: $(ffmpeg -version | head -n 1)"

echo "📥 [4/5] Setting up ClipFlip crawler workspace..."
mkdir -p /home/ubuntu/clipflip-worker
cd /home/ubuntu/clipflip-worker

if [ ! -d ".git" ]; then
    echo "Cloning repository..."
    git clone https://github.com/Belendor/clip-flip.git .
fi

git pull origin main
npm install

echo "⚙️ [5/5] Creating crawler runner helper..."
cat << 'EOF' > /home/ubuntu/run-crawler.sh
#!/usr/bin/env bash
# Usage: ./run-crawler.sh <subreddit> [limit] [target_url]
SUBREDDIT="${1:-traps}"
LIMIT="${2:-15}"
TARGET="${3:-https://clip-flip.com}"

echo "Starting crawler for r/$SUBREDDIT (limit: $LIMIT) -> $TARGET"
cd /home/ubuntu/clipflip-worker
npx tsx scripts/crawler/cli.ts --subreddit "$SUBREDDIT" --limit "$LIMIT" --target "$TARGET"
EOF

chmod +x /home/ubuntu/run-crawler.sh

echo ""
echo "=================================================================="
echo "✅ ClipFlip Crawler Worker Setup Complete!"
echo "To run a crawler job:"
echo "  /home/ubuntu/run-crawler.sh traps 10 https://clip-flip.com"
echo "Or with custom options:"
echo "  cd /home/ubuntu/clipflip-worker && npm run crawl -- --subreddit shemales --limit 20"
echo "=================================================================="
