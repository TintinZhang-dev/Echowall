#!/bin/bash
# Deploy script - updates cache version and syncs to VPS
VERSION=$(date +%Y%m%d%H%M)
echo "Deploy version: $VERSION"

# ===== 安全护栏（2026-09-13 教训）=====
# 白标化代码在缺 site.config.json 时会回退到 site.config.example.json（某某中学）！
# 而 site.config.json 被 rsync 排除、只存在于服务器本地 —— 部署前必须先确认它在。
if ! ssh your-server "test -f /root/phewall/site.config.json"; then
  echo "❌ 目标机缺少 /root/phewall/site.config.json —— 拒绝部署"
  echo "   否则站点会加载 example 配置（显示某某中学）。首次启用白标化代码前先跑："
  echo "     scp ~/phewall/site.config.json your-server:/root/phewall/"
  exit 1
fi

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
  --exclude 'site.config.json' --exclude 'keystore/' \
  ./ your-server:/root/phewall/

# Restart（优先从 ecosystem 文件重载，保证 env / JWT_SECRET 与文件一致；
# 平 pm2 restart <name> --update-env 不会重读 ecosystem，改了 env 会不生效）
ssh your-server "cd /root/phewall && if [ -f ecosystem.config.cjs ]; then pm2 startOrRestart ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null && echo 'restarted (ecosystem)'; else pm2 restart phewall --update-env; fi"
echo "Deployed v$VERSION"
