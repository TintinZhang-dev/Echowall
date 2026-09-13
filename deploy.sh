#!/bin/bash
# ============================================================
# EchoWall 部署脚本：递增缓存版本号 → rsync 同步到服务器 → 重启 pm2
#
# 目标服务器通过环境变量配置（不要在仓库里写死）：
#   DEPLOY_TARGET      SSH 别名 / host（默认 your-server）
#   DEPLOY_REMOTE_DIR  远端目录（默认 /root/phewall）
#   DEPLOY_PM2_NAME    pm2 进程名（默认 phewall）
#
# 例：DEPLOY_TARGET=my-vps ./deploy.sh
# ============================================================
set -euo pipefail

VERSION=$(date +%Y%m%d%H%M)
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${DEPLOY_TARGET:-your-server}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/root/phewall}"
PM2_NAME="${DEPLOY_PM2_NAME:-phewall}"

echo "Deploy version: $VERSION → $TARGET:$REMOTE_DIR"

[ "$TARGET" = "your-server" ] && { echo "❌ 请用 DEPLOY_TARGET 指定目标服务器（或修改默认值）"; exit 1; }

# ===== 安全护栏（2026-09-13 教训）=====
# 白标化代码在缺 site.config.json 时会回退到 site.config.example.json（某某中学）！
# 而 site.config.json 被 rsync 排除、只存在于服务器本地 —— 部署前必须先确认它在。
if ! ssh "$TARGET" "test -f $REMOTE_DIR/site.config.json"; then
  echo "❌ 目标机缺少 $REMOTE_DIR/site.config.json —— 拒绝部署"
  echo "   否则站点会加载 example 配置。首次启用白标化代码前先跑："
  echo "     scp site.config.json $TARGET:$REMOTE_DIR/"
  exit 1
fi

cd "$SRC_DIR"

# 更新所有 HTML 里的缓存版本号（只动 ?v= / &v= 查询参数，绝不误伤 JS 里的 v= 赋值）
for f in public/*.html; do
  sed -i "s|\([?&]\)v=[A-Za-z0-9]*|\1v=$VERSION|g" "$f"
done

# 同步到服务器
# ⚠️ site.config.json 已排除：它是每校独立实例配置，只存在于服务器本地，绝不从开发机覆盖。
#    （rsync --exclude 同时保护服务器上已有的该文件不被 --delete 删除）
#    首次在某站点启用白标化代码时，需先手动放一次：
#      scp site.config.json <TARGET>:<REMOTE_DIR>/
rsync -av --delete \
  --exclude 'node_modules' --exclude '.git' --exclude 'data.db*' \
  --exclude 'uploads/*' --exclude 'package-lock.json' \
  --exclude 'ecosystem.config.cjs' --exclude 'debug-errors.log' \
  --exclude 'site.config.json' --exclude 'keystore/' \
  "$SRC_DIR/" "$TARGET:$REMOTE_DIR/"

# Restart（优先从 ecosystem 文件重载，保证 env / JWT_SECRET 与文件一致；
# 平 pm2 restart <name> --update-env 不会重读 ecosystem，改了 env 会不生效）
ssh "$TARGET" "cd $REMOTE_DIR && if [ -f ecosystem.config.cjs ]; then pm2 startOrRestart ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null && echo 'restarted (ecosystem)'; else pm2 restart $PM2_NAME --update-env; fi"
echo "Deployed v$VERSION"
