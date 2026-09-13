#!/usr/bin/env bash
# ============================================================
# Phewall 白标化 · Phase D —— 一键开通新学校实例
#
#   ./provision-school.sh --id <schoolId> --name "<校名>" [选项] [--deploy]
#
# 本地阶段（总是执行）：
#   1) 生成 site.config.json（校名/品牌/板块/域名/后台路径/存储前缀）
#   2) 生成独立签名 keystore（keytool）+ 指纹
#   3) 生成 TWA school.json，可选构建该校 APK（默认版本 1.0.0，不继承华普 VERSION）
#   4) 输出部署清单 deploy-manifest.md
# 远程阶段（加 --deploy 才执行）：
#   5) VPS 建目录 + rsync 代码 + 传 config + npm install + init-site
#   6) 写 ecosystem + pm2 起实例
#   7) Cloudflare Tunnel ingress + DNS CNAME
#   8) 每校加密备份脚本 + crontab（R2 前缀隔离）
#
# 安全：绝不触碰华普实例(phe)的 data.db / keystore；全部远程操作幂等。
# ============================================================
set -euo pipefail

# ---------------- 默认值 ----------------
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
TWA_DIR="$HOME/phewall-twa"
STAGING_ROOT="$HOME/phewall-provision"
KEYSTORE_DIR="$HOME/phewall/keystore"
TARGET="your-server"
REMOTE_BASE="/root/phewall"
ZONE="phewall.com"

ID=""; NAME=""; SHORT=""; ABBR=""; DOMAIN=""; EMAIL=""
THEME="#1D9BF0"; LOGO_TEXT=""; SLOGAN=""; PRODUCT_NAME="EchoWall"; PRODUCT_NAMEZH="回声墙"
PKG=""; BOARDS_FILE=""; HAS_CLASSES=1
TARGET_PORT=""; APK_VERSION=""; FOUNDER_NAME=""
DEPLOY=0; FORCE=0
SKIP_APK=0; SKIP_DOMAIN=0; SKIP_BACKUP=0; SKIP_INSTALL=0

# ---------------- 参数解析 ----------------
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --short) SHORT="$2"; shift 2 ;;
    --abbr) ABBR="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --theme) THEME="$2"; shift 2 ;;
    --logo-text) LOGO_TEXT="$2"; shift 2 ;;
    --slogan) SLOGAN="$2"; shift 2 ;;
    --product-name) PRODUCT_NAME="$2"; shift 2 ;;
    --package) PKG="$2"; shift 2 ;;
    --boards) BOARDS_FILE="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --port) TARGET_PORT="$2"; shift 2 ;;
    --version) APK_VERSION="$2"; shift 2 ;;
    --founder) FOUNDER_NAME="$2"; shift 2 ;;
    --no-classes) HAS_CLASSES=0; shift ;;
    --deploy) DEPLOY=1; shift ;;
    --force) FORCE=1; shift ;;
    --skip-apk) SKIP_APK=1; shift ;;
    --skip-domain) SKIP_DOMAIN=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "❌ 未知参数: $1"; exit 1 ;;
  esac
done

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

# ---------------- 校验 ----------------
[ -n "$ID" ] || { red "缺少 --id"; exit 1; }
[ -n "$NAME" ] || { red "缺少 --name"; exit 1; }
case "$ID" in
  phe) red "--id 不能是 phe（保留给华普旗舰实例）"; exit 1 ;;
  [a-z]*) : ;;
  *) red "非法 --id（须小写字母开头）: $ID"; exit 1 ;;
esac
case "$ID" in *[!a-z0-9-]*) red "非法 --id（只允许 a-z0-9-）: $ID"; exit 1 ;; esac
[ ${#ID} -le 31 ] || { red "--id 太长（>31）"; exit 1; }

SHORT="${SHORT:-$NAME}"
ABBR="${ABBR:-$ID}"
DOMAIN="${DOMAIN:-$ID.$ZONE}"
EMAIL="${EMAIL:-admin@$DOMAIN}"
LOGO_TEXT="${LOGO_TEXT:-$NAME}"
SLOGAN="${SLOGAN:-每所学校都该有的墙}"
FOUNDER_NAME="${FOUNDER_NAME:-$NAME 站长}"
PKG="${PKG:-com.echowall.$(printf '%s' "$ID" | tr -d '-')}"

STAGING="$STAGING_ROOT/$ID"
TWA_SCHOOL_DIR="$TWA_DIR/schools/$ID"
KS_PATH="$KEYSTORE_DIR/${ID}-release.keystore"
KS_PASS_FILE="$KEYSTORE_DIR/.${ID}-pass"
KS_ALIAS="$ID"
REMOTE_DIR="$REMOTE_BASE-$ID"

step "开通「$NAME」($ID)"
echo "  域名:     $DOMAIN"
echo "  包名:     $PKG"
echo "  存储前缀: $ID/  （R2 对象键隔离）"
echo "  远程目标: $TARGET:$REMOTE_DIR"
[ "$DEPLOY" = 1 ] && ylw "  模式: 本地生成 + 远程部署 (--deploy)" || ylw "  模式: 仅本地生成（加 --deploy 才动远程）"

# ---------------- 预检 ----------------
step "0/8 预检"
command -v node >/dev/null || { red "缺 node"; exit 1; }
command -v keytool >/dev/null || { red "缺 keytool(java)"; exit 1; }
if [ -e "$STAGING" ] && [ "$FORCE" != 1 ]; then
  red "staging 已存在：$STAGING（加 --force 覆盖）"; exit 1
fi
if [ "$DEPLOY" = 1 ]; then
  ssh -o ConnectTimeout=10 "$TARGET" true || { red "无法连接 $TARGET"; exit 1; }
fi
strategy_boards="$SELF_DIR/site.config.example.json"
[ -n "$BOARDS_FILE" ] || BOARDS_FILE="$strategy_boards"
[ -f "$BOARDS_FILE" ] || { red "板块文件不存在: $BOARDS_FILE"; exit 1; }
grn "  预检通过"

# ---------------- 1. staging 目录 ----------------
step "1/8 生成目录与配置"
mkdir -p "$STAGING" "$STAGING/keystore"
chmod 700 "$STAGING"

ADMIN_PATH="/manage-$(openssl rand -hex 6)"

export ID NAME SHORT ABBR DOMAIN EMAIL THEME LOGO_TEXT SLOGAN PRODUCT_NAME PRODUCT_NAMEZH PKG HAS_CLASSES FOUNDER_NAME ADMIN_PATH BOARDS_FILE
node - "$STAGING/site.config.json" <<'NODE'
const fs = require('fs');
const e = process.env;
let boards = [];
try {
  const raw = JSON.parse(fs.readFileSync(e.BOARDS_FILE, 'utf8'));
  boards = (raw.registry && raw.registry.boards) || raw.boards || [];
} catch (_) { boards = []; }
const cfg = {
  school: { name: e.NAME, shortName: e.SHORT, abbr: e.ABBR, hasClassSystem: e.HAS_CLASSES === '1' },
  product: { name: e.PRODUCT_NAME, nameZh: e.PRODUCT_NAMEZH, slogan: e.SLOGAN },
  brand: { logoText: e.LOGO_TEXT, themeColor: e.THEME },
  support: { contactEmail: e.EMAIL },
  founder: { name: e.FOUNDER_NAME, nameEn: '', wechat: '', link: '', showInFooter: true, showOnAbout: true, exposeInApi: true },
  registry: { boards },
  welcomePost: { content: '👋 欢迎来到 {school} 校园墙！这里是 {school} 同学们自由交流的地方——你可以匿名或实名发帖、评论、点赞、转发，在分区里找到同好。有任何问题或建议，随时联系站长。' },
  adminPath: e.ADMIN_PATH,
  domain: e.DOMAIN,
  storage: { keyPrefix: e.ID + '/' },
  app: { packageId: e.PKG, sha256Fingerprint: '' }
};
fs.writeFileSync(process.argv[2], JSON.stringify(cfg, null, 2) + '\n');
console.log('  ✓ site.config.json (' + boards.length + ' 板块)');
NODE

# ---------------- 2. keystore ----------------
step "2/8 生成独立签名 keystore"
if [ -f "$KS_PATH" ] && [ -f "$KS_PASS_FILE" ]; then
  KS_PASS="$(cat "$KS_PASS_FILE")"
  grn "  复用已有 keystore: $KS_PATH"
else
  KS_PASS="$(openssl rand -base64 24)"
  umask 077
  printf '%s' "$KS_PASS" > "$KS_PASS_FILE"; chmod 600 "$KS_PASS_FILE"
  keytool -genkeypair -v -keystore "$KS_PATH" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=$NAME, O=$PRODUCT_NAME, C=CN" >/dev/null 2>&1
  grn "  已生成 keystore: $KS_PATH"
fi
FINGERPRINT="$(keytool -list -v -keystore "$KS_PATH" -alias "$KS_ALIAS" -storepass "$KS_PASS" 2>/dev/null | awk -F'SHA256: ' '/SHA256:/{print $2; exit}')"
[ -n "$FINGERPRINT" ] || { red "无法读取指纹"; exit 1; }
echo "  指纹: $FINGERPRINT"
# 归档一份到 staging
cp -a "$KS_PATH" "$STAGING/keystore/"; cp -a "$KS_PASS_FILE" "$STAGING/keystore/"
chmod 600 "$STAGING/keystore/"*

# 指纹写回 config
node - "$STAGING/site.config.json" "$FINGERPRINT" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
c.app.sha256Fingerprint = process.argv[3];
fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
NODE

# ---------------- 3. TWA school.json + APK ----------------
step "3/8 生成 TWA school.json"
mkdir -p "$TWA_SCHOOL_DIR"
export TWA_SCHOOL_DIR KS_PATH KS_ALIAS KS_PASS_FILE APK_VERSION
node - "$TWA_SCHOOL_DIR/school.json" <<'NODE'
const fs = require('fs');
const e = process.env;
const obj = {
  schoolId: e.ID,
  packageId: e.PKG,
  appName: e.NAME + '校园墙',
  launcherName: e.LOGO_TEXT,
  host: e.DOMAIN,
  themeColor: e.THEME,
  themeColorDark: '#000000',
  backgroundColor: '#FFFFFF',
  userAgentBrand: (e.LOGO_TEXT.replace(/[^A-Za-z0-9]/g, '') || 'EchoWall') + 'App',
  keystorePath: e.KS_PATH,
  keystoreAlias: e.KS_ALIAS,
  keystorePassFile: e.KS_PASS_FILE,
  versionCode: 0
};
fs.writeFileSync(process.argv[2], JSON.stringify(obj, null, 2) + '\n');
console.log('  ✓ ' + process.argv[2]);
NODE

APK_OUT=""
if [ "$SKIP_APK" = 1 ]; then
  ylw "  跳过 APK 构建（--skip-apk）"
else
  step "3b/8 构建 APK（Phase C build-apk.sh）"
  ( cd "$TWA_DIR" && ./build-apk.sh "$ID" ${APK_VERSION:-1.0.0} )
  APK_OUT="$(ls -t "$TWA_DIR/dist/$ID"/*.apk 2>/dev/null | head -1 || true)"
  [ -n "$APK_OUT" ] && grn "  APK: $APK_OUT" || ylw "  未找到 APK 产物"
fi

# ---------------- 4. 定端口 ----------------
step "4/8 分配端口"
if [ -n "$TARGET_PORT" ]; then
  PORT="$TARGET_PORT"
elif [ "$DEPLOY" = 1 ]; then
  PORT="$(ssh "$TARGET" 'for p in $(seq 3101 3199); do ss -ltn 2>/dev/null | grep -q ":$p " || { echo $p; break; }; done')"
  [ -n "$PORT" ] || { red "3101-3199 无空闲端口"; exit 1; }
else
  PORT="3101"
fi
echo "  端口: $PORT"

# ---------------- 5. 部署清单 ----------------
MANIFEST="$STAGING/deploy-manifest.md"
cat > "$MANIFEST" <<EOF
# 部署清单 · $NAME ($ID)

> 生成时间：$(date '+%F %T %Z') · 由 provision-school.sh 自动生成

## 基本信息
| 项 | 值 |
|---|---|
| 学校 ID | \`$ID\` |
| 显示名 | $NAME |
| 简称 | $SHORT |
| 域名 | https://$DOMAIN |
| 支持邮箱 | $EMAIL |
| 届/班体系 | $([ "$HAS_CLASSES" = 1 ] && echo 开 || echo 关) |
| 主题色 | $THEME |

## 技术参数
| 项 | 值 |
|---|---|
| 包名 | \`$PKG\` |
| SHA-256 指纹 | \`$FINGERPRINT\` |
| 后台路径 | \`$ADMIN_PATH\` |
| 端口 | $PORT |
| 远程目录 | \`$TARGET:$REMOTE_DIR\` |
| R2 前缀 | \`$ID/\`（备份在 \`backups/$ID/\`） |
| keystore | \`$KS_PATH\`（+ \`.${ID}-pass\`） |

## 配置文件
- site.config.json: \`$STAGING/site.config.json\`
- TWA school.json: \`$TWA_SCHOOL_DIR/school.json\`
$([ -n "$APK_OUT" ] && echo "- APK: \`$APK_OUT\`")

## 上线步骤
1. \`./provision-school.sh --id $ID ... --deploy\`（已完成则跳过）
2. 注册第一个账号 → 设为创始人/管理员（后台 \`$ADMIN_PATH\`）
3. 跑 \`npm run init-site\` 生成欢迎帖（部署时已自动跑；无管理员时需注册后再跑一次）
4. 手机浏览器打开 https://$DOMAIN/app 安装 APK
5. 验收：逐页确认无「华普/华二普陀」字样

## ⚠️ 必须备份
- \`$KS_PATH\` + \`$KS_PASS_FILE\` —— **丢失则无法覆盖安装 APK**
- \`/root/backup-key-$ID\`（远程，备份解密密钥）
EOF
grn "  ✓ $MANIFEST"

# ---------------- 完成本地阶段 ----------------
if [ "$DEPLOY" != 1 ]; then
  echo
  grn "✅ 本地生成完成（未动远程）。确认无误后加 --deploy 执行远程部署。"
  echo "   staging: $STAGING"
  exit 0
fi

# ================= 远程部署 =================
step "5/8 同步代码到 $TARGET:$REMOTE_DIR"
ssh "$TARGET" "mkdir -p '$REMOTE_DIR'"
rsync -az --delete \
  --exclude 'node_modules' --exclude '.git' --exclude 'data.db*' \
  --exclude 'uploads/*' --exclude 'ecosystem.config.cjs' \
  --exclude 'debug-errors.log' --exclude 'site.config.json' \
  --exclude 'keystore/' \
  "$SELF_DIR/" "$TARGET:$REMOTE_DIR/"
scp -q "$STAGING/site.config.json" "$TARGET:$REMOTE_DIR/site.config.json"
ssh "$TARGET" "chmod 600 '$REMOTE_DIR/site.config.json'"
grn "  代码 + 配置已同步"

step "6/8 安装依赖 + 初始化站点"
if [ "$SKIP_INSTALL" != 1 ]; then
  ssh "$TARGET" "cd '$REMOTE_DIR' && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 && echo '  ✓ npm install'"
fi
ssh "$TARGET" "cd '$REMOTE_DIR' && npm run init-site 2>&1 | sed 's/^/  /'"

step "6b/8 写 ecosystem + 起 pm2"
ssh "$TARGET" "bash '$REMOTE_DIR/scripts/provision-remote.sh' install '$ID' '$PORT' '$ADMIN_PATH'"
ssh "$TARGET" "cd '$REMOTE_DIR' && pm2 startOrRestart ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null && echo '  ✓ pm2 已启动 phewall-$ID'"

step "6c/8 健康检查"
sleep 2
ssh "$TARGET" "curl -s -o /dev/null -w '  HTTP %{http_code}\n' http://localhost:$PORT/ || true"

if [ "$SKIP_DOMAIN" != 1 ]; then
  step "7/8 配置域名（Tunnel ingress + DNS）"
  ssh "$TARGET" "bash '$REMOTE_DIR/scripts/provision-remote.sh' domain '$ID' '$DOMAIN' '$PORT' '$ZONE'"
else
  ylw "7/8 跳过域名（--skip-domain）"
fi

if [ "$SKIP_BACKUP" != 1 ]; then
  step "8/8 安装备份"
  ssh "$TARGET" "bash '$REMOTE_DIR/scripts/provision-remote.sh' backup '$ID'"
else
  ylw "8/8 跳过备份（--skip-backup）"
fi

# 把 APK 放在远程供下载（可选）
echo
grn "✅ 开通完成：$NAME → https://$DOMAIN"
echo "   清单: $MANIFEST"
[ -n "$APK_OUT" ] && echo "   APK:  $APK_OUT"
echo "   后台: https://$DOMAIN$ADMIN_PATH"
