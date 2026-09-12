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
# ⚠️ site.config.json 已排除：它是每校独立实例配置，只存在于服务器本地，绝不从开发机覆盖。
#    （rsync --exclude 同时保护服务器上已有的该文件不被 --delete 删除）
#    首次在某站点启用白标化代码时，需先手动放一次：
#      scp ~/phewall/site.config.json your-server:/root/phewall/
rsync -av --delete \
  --exclude 'node_modules' --exclude '.git' --exclude 'data.db*' \
  --exclude 'uploads/*' --exclude 'package-lock.json' \
  --exclude 'ecosystem.config.cjs' --exclude 'debug-errors.log' \
  --exclude 'site.config.json' \
  ./ your-server:/root/phewall/

# Restart
ssh your-server "cd /root/phewall && pm2 restart phewall --update-env"
echo "Deployed v$VERSION"
