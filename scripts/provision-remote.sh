#!/usr/bin/env bash
# ============================================================
# Phewall 白标化 · Phase D —— 服务端（VPS）执行助手
#   由 provision-school.sh 通过 SSH 调用，也可手动在 VPS 上跑。
#
# 子命令：
#   install <id> <port> <adminPath>          写 ecosystem.config.cjs（从 /root/.r2-env 注入 R2 凭据）
#   backup  <id>                             装每校加密备份脚本 + crontab（R2 前缀 backups/<id>/）
#   domain  <id> <hostname> <port> <zone>    加 Cloudflare Tunnel ingress + DNS CNAME（幂等）
#
# 依赖（VPS 本地）：node, openssl, pm2, curl, jq；token 文件 /root/.cf-token
# 铁律：不改动其它实例；config.yml / crontab 改前先备份；全部操作幂等。
# ============================================================
set -euo pipefail

CMD="${1:-}"
CFG_YML="/root/.cloudflared/config.yml"
CF_TOKEN_FILE="/root/.cf-token"
R2_ENV="/root/.r2-env"

die() { echo "❌ $*" >&2; exit 1; }

# 确保共享 R2 凭据文件存在（从现有 phewall ecosystem 抽取，绝不打印密钥）
ensure_r2_env() {
  [ -f "$R2_ENV" ] && return 0
  [ -f /root/phewall/ecosystem.config.cjs ] || die "无 /root/phewall/ecosystem.config.cjs，无法抽取 R2 凭据"
  node -e '
    const fs=require("fs");
    const t=fs.readFileSync("/root/phewall/ecosystem.config.cjs","utf8");
    const get=k=>{const m=t.match(new RegExp(k+":\\s*[\x27\"]([^\x27\"]+)[\x27\"]"));return m?m[1]:"";};
    const out=["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY"].map(k=>k+"="+get(k)).join("\n")+"\n";
    fs.writeFileSync("/root/.r2-env",out,{mode:0o600});
  '
  chmod 600 "$R2_ENV"
  echo "[r2-env] 已生成 $R2_ENV"
}

# 读取 tunnel id（config.yml 第一行 tunnel: xxx）
tunnel_id() { awk '/^tunnel:/{print $2; exit}' "$CFG_YML"; }

cf_api() { # cf_api <method> <path> [json]
  local m="$1" p="$2" d="${3:-}"
  if [ -n "$d" ]; then
    curl -s -X "$m" -H "Authorization: Bearer $(cat "$CF_TOKEN_FILE")" -H "Content-Type: application/json" --data "$d" "https://api.cloudflare.com/client/v4$p"
  else
    curl -s -X "$m" -H "Authorization: Bearer $(cat "$CF_TOKEN_FILE")" "https://api.cloudflare.com/client/v4$p"
  fi
}

# ---------------- install ----------------
cmd_install() {
  local id="$1" port="$2" admin_path="$3"
  local dir="/root/phewall-$id"
  [ -d "$dir" ] || die "实例目录不存在：$dir"
  ensure_r2_env
  set -a; . "$R2_ENV"; set +a
  umask 077
  cat > "$dir/ecosystem.config.cjs" <<EOF
module.exports = {
  apps: [{
    name: 'phewall-$id',
    cwd: '$dir',
    script: 'server/index.js',
    env: {
      PORT: '$port',
      ADMIN_PATH: '$admin_path',
      LOGIN_GATE: 'on',
      RATE_LIMIT_DISABLED: '1',
      R2_ACCOUNT_ID: '$R2_ACCOUNT_ID',
      R2_ACCESS_KEY_ID: '$R2_ACCESS_KEY_ID',
      R2_SECRET_ACCESS_KEY: '$R2_SECRET_ACCESS_KEY'
    }
  }]
};
EOF
  chmod 600 "$dir/ecosystem.config.cjs"
  echo "[install] 已写 $dir/ecosystem.config.cjs（端口 $port，后台 $admin_path）"
}

# ---------------- backup ----------------
cmd_backup() {
  local id="$1"
  local dir="/root/phewall-$id"
  [ -d "$dir" ] || die "实例目录不存在：$dir"
  ensure_r2_env
  local key="/root/.backup-key-$id"
  if [ ! -f "$key" ]; then
    umask 077
    openssl rand -base64 32 > "$key"
    chmod 600 "$key"
    echo "[backup] 已生成密钥 $key"
  fi
  local sh="/root/backup-$id.sh"
  cat > "$sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
set -a; . $R2_ENV; set +a
cd $dir
echo "[\$(date '+%F %T')] 备份 $id 开始" >> /var/log/phewall-backup.log
node scripts/backup-site.js --dir $dir --prefix backups/$id/ --key $key >> /var/log/phewall-backup.log 2>&1
echo "[\$(date '+%F %T')] 备份 $id 完成" >> /var/log/phewall-backup.log
EOF
  chmod 700 "$sh"
  # crontab 幂等：先删同校旧行再加
  ( crontab -l 2>/dev/null | grep -v "backup-$id.sh" || true; echo "5 3 * * * $sh" ) | crontab -
  echo "[backup] 已装 $sh + crontab（每天 03:05 UTC）"
}

# ---------------- domain ----------------
cmd_domain() {
  local id="$1" hostname="$2" port="$3" zone="$4"
  local tid; tid="$(tunnel_id)"
  [ -n "$tid" ] || die "无法从 $CFG_YML 读取 tunnel id"

  # 1) ingress 幂等插入（404 兜底之前）
  if grep -q "hostname: $hostname" "$CFG_YML"; then
    echo "[domain] ingress 已存在：$hostname（跳过）"
  else
    cp -a "$CFG_YML" "$CFG_YML.bak.$(date +%Y%m%d%H%M%S)"
    local tmp; tmp="$(mktemp)"
    awk -v h="$hostname" -v p="$port" '
      /- service: http_status:404/ && !done {
        print "  - hostname: " h
        print "    service: http://localhost:" p
        done=1
      }
      { print }
    ' "$CFG_YML" > "$tmp"
    grep -q "hostname: $hostname" "$tmp" || { rm -f "$tmp"; die "ingress 插入失败"; }
    mv "$tmp" "$CFG_YML"
    echo "[domain] 已加 ingress：$hostname → localhost:$port"
    pm2 restart cf-tunnel >/dev/null 2>&1 && echo "[domain] cf-tunnel 已重启"
  fi

  # 2) DNS CNAME 幂等
  local zid
  zid="$(cf_api GET "/zones?name=$zone" | jq -r '.result[0].id // empty')"
  [ -n "$zid" ] || die "找不到 zone：$zone"
  local existing
  existing="$(cf_api GET "/zones/$zid/dns_records?name=$hostname" | jq -r '.result[0].id // empty')"
  local target="$tid.cfargotunnel.com"
  if [ -n "$existing" ]; then
    echo "[domain] DNS 已存在：$hostname（跳过）"
  else
    local resp; resp="$(cf_api POST "/zones/$zid/dns_records" "{\"type\":\"CNAME\",\"name\":\"$hostname\",\"content\":\"$target\",\"proxied\":true}")"
    echo "$resp" | jq -e '.success==true' >/dev/null || die "DNS 创建失败：$(echo "$resp" | jq -c '.errors')"
    echo "[domain] 已加 DNS：$hostname → $target (proxied)"
  fi
}

case "$CMD" in
  install) shift; cmd_install "$@" ;;
  backup)  shift; cmd_backup "$@" ;;
  domain)  shift; cmd_domain "$@" ;;
  *) echo "用法: $0 {install|backup|domain} ..." >&2; exit 1 ;;
esac
