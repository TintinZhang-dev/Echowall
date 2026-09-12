#!/bin/bash
# Deploy script - updates cache version and syncs to VPS
VERSION=$(date +%Y%m%d%H%M)
echo "Deploy version: $VERSION"

# Update version in all HTML files — only touch query-param version refs (?v= / &v=), never bare "v=" inside JS code
cd .
for f in public/*.html; do
  sed -i "s|\([?&]\)v=[A-Za-z0-9]*|\1v=$VERSION|g" "$f"
done

# Sync to VPS
rsync -av --delete --exclude 'node_modules' --exclude '.git' --exclude 'data.db*' --exclude 'uploads/*' --exclude 'package-lock.json' --exclude 'ecosystem.config.cjs' --exclude 'debug-errors.log' ./ your-server:/root/phewall/

# Restart
ssh your-server "cd /root/phewall && pm2 restart phewall --update-env"
echo "Deployed v$VERSION"
