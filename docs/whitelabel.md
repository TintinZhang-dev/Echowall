# Phewall 白标化 · 换学校指南（Phase A）

> 目标：把品牌文案抽到 `site.config.json`，**改配置就能换一所学校，不改代码**。
> 本文档面向「要给新学校开一套墙」的运维场景。

## 一、机制总览

```
site.config.json（真实实例，不入库）
      │  读取顺序：site.config.json → site.config.example.json（缺失则回退）
      ▼
server/config.js（加载 + 深合并默认值 + 校验 school.name/product.name）
      ├── server/routes/site.js  →  GET /api/site-config（公开字段白名单，未登录可用）
      ├── server/routes/auth.js / admin.js / index.js → 服务端模板读 config
      └── public/js/site.js  →  前端拉取 /api/site-config，注入页面
```

- 服务端：`site.config.json` 改动在**重启进程后生效**（`pm2 restart phewall`）。
- 前端：页面加载时 `site.js` 拉取 `/api/site-config`（带 `localStorage` 缓存回退，接口抖动不白屏），把文案/主题色/页脚注入 DOM。

## 二、两层命名（务必分清）

| 字段 | 示例值 | 用在哪 |
|---|---|---|
| `brand.logoText` | `Phewall` | 页面 `<title>`、页头、侧边栏 Logo、登录/注册页标题 |
| `product.name` | `EchoWall` | 页脚署名、"Powered by"、`/about` 页 |
| `school.name` | `华二普陀` | 正文里提到学校名的地方 |
| `product.slogan` | 每所学校都该有的墙 | `/about` 页 |

> 页脚署名格式固定为：`© {year} {product.name} · 由 {founder.name}（{founder.nameEn}）创建`，名字带链接到 `founder.link`。

## 三、开一所新学校（操作步骤）

1. **复制模板为真实实例配置**（真实实例配置已被 `.gitignore` 排除，不入库）：

   ```bash
   cp site.config.example.json site.config.json
   ```

2. **改 `site.config.json`**，至少改这几个字段：

   ```json
   {
     "school":   { "name": "某某中学", "shortName": "某某", "abbr": "xx", "hasClassSystem": true },
     "product":  { "name": "EchoWall", "nameZh": "回声墙", "slogan": "每所学校都该有的墙" },
     "brand":    { "logoText": "某某墙", "themeColor": "#FF5500" },
     "support":  { "contactEmail": "admin@example.com" },
     "founder":  { "name": "…", "nameEn": "…", "wechat": "…", "link": "…",
                   "showInFooter": true, "showOnAbout": true, "exposeInApi": true },
     "registry": { "boards": [{ "name": "足球", "icon": "⚽", "description": "…" }] },
     "welcomePost": { "content": "👋 欢迎来到 {school} 校园墙！…（可由每校自定义）" },
     "adminPath": "/manage-changeme",
     "domain":   "example.com"
   }
   ```

   > `adminPath` 真实值应随机生成（避免被猜到），且建议以 `/manage-` 开头（登录门禁放行 `p.startsWith('/manage-')`）。

3. **初始化数据**（新库首次部署后跑一次，幂等）：

   ```bash
   npm run init-site     # 按 config 播种板块 + 空库时创建置顶欢迎帖
   ```

4. **部署 + 重启**：

   ```bash
   ./deploy.sh          # rsync 到 VPS（site.config.json 已排除，不会被覆盖）
   # deploy.sh 末尾已自动执行 pm2 restart phewall
   ```

   > ⚠️ **`deploy.sh` 不传 `site.config.json`**（它是每校独立配置，只存在于服务器本地）。
   > 首次在某个站点启用白标化代码时，需先手动放一次，否则服务因缺配置启动失败：
   > ```bash
   > scp ~/phewall/site.config.json <host>:/root/phewall/
   > ```
   > 之后每次 deploy 都会保留服务器上已有的 `site.config.json`（`--exclude` 同时防止 `--delete` 删它）。

5. **验证**：`curl https://<domain>/api/site-config` 应返回新学校名；刷新页面，标题/页头/页脚/主题色全部变。

## 四、字段说明

| 字段 | 说明 |
|---|---|
| `school.name` / `shortName` / `abbr` | 全名、简称、缩写（如 `phe`，用于条款里 `（phe）` 之类正文） |
| `school.hasClassSystem` | `false` 时走外校语义：注册/登录只留用户名+学校，后端强制 `year=0`（见下） |
| `product.name` / `nameZh` / `slogan` | 产品名（英文/中文/口号），用于页脚与 `/about` |
| `brand.logoText` / `themeColor` | 站点对外品牌名 + 全局主题色（`--accent`） |
| `support.contactEmail` | 所有对外联系邮箱（含 `security.txt`、注册欢迎通知、FAQ） |
| `founder.*` | 创始人署名；`wechat` 为空时，申诉/重置/封禁通知里的微信文案自动省略 |
| `founder.showInFooter` | `false` 时页脚署名不渲染（默认 `true`） |
| `founder.exposeInApi` | `false` 时 `/api/site-config` 不返回 `founder` 对象（默认 `true`） |
| `registry.boards` | 分区对象数组 `[{name,icon,description}]`（兼容字符串），空数组则跳过播种；只增不删 |
| `welcomePost.content` | 空库时 `init-site.js` 创建的置顶欢迎帖文案，支持 `{school}`/`{product}` 占位符 |
| `adminPath` | 后台路径（优先级 `siteConfig.adminPath` → `ADMIN_PATH` → `/admin`） |
| `domain` | 用于 `security.txt` 的 Canonical/Policy URL 与通知里的协议链接 |

## 五、接口约定

### `GET /api/site-config`（未登录可访问）

返回公开字段白名单（不含任何密钥/路径/后台地址）：

```json
{
  "school":  { "name": "…", "shortName": "…", "abbr": "…", "hasClassSystem": true },
  "product": { "name": "…", "nameZh": "…", "slogan": "…" },
  "brand":   { "logoText": "…", "themeColor": "…" },
  "support": { "contactEmail": "…" },
  "domain":  "…",
  "founder": { "name": "…", "nameEn": "…", "wechat": "…", "link": "…" }  // exposeInApi:false 时省略
}
```

### `GET /api/version`（留痕）

```json
{ "version": "1.0.0", "product": "EchoWall", "founder": "Tintin Zhang" }
```

## 六、前端注入规则（`public/js/site.js`）

- `[data-site="school.name"]` → `textContent = 配置值`（支持点路径）
- `[data-site="如 {school.name}（外校同学可不填）"]` → 含 `{path}` 占位符则整段模板替换
- `[data-site-attr="placeholder"]` + `[data-site=…]` → 写到指定属性（用于 input placeholder）
- `[data-site-href="founder.link"]` → 设置 `<a>` 的 `href`
- `<title data-site-title="登录|brand.logoText">` → 标题拼成 `登录 — Phewall`
- `brand.themeColor` → `document.documentElement` 的 `--accent` + `<meta name="theme-color">`
- `school.hasClassSystem === false` → 给 `<body>` 加 `.no-class-system`，并回调 `window.__onSiteConfigLoaded(cfg)`（注册/登录页据此隐藏届/班级字段、切换文案）
- 页脚署名统一注入所有页面（含登录/注册页）

## 七、Phase A 不处理（列入 Phase C）

以下内容为**静态/功能性标识**，Phase A 不改为读 config（改了就坏或服务端注入不到）：

- `public/manifest.json`（name/short_name/theme_color）
- `public/favicon.svg`、`public/sw.js` 的注释与缓存名 `phewall-static-v1`
- `public/app.js` 里的 `PhewallApp/` UA 正则、`window.PhewallBridge`、`/downloads/Phewall-latest.apk` 路径
- `server/index.js` 里 APK 文件名正则 `^Phewall-v[\d.]+\.apk$`、`public/downloads/*.apk` 二进制

## 八、注意事项

- **不改代码**的前提下，换学校 = 改 `site.config.json` + `pm2 restart`。
- `site.config.json` 已被 `.gitignore` 排除，**签名私钥 `keystore/`、`ecosystem.config.cjs`、`.env` 同样不入库**。
- 改完务必跑 `curl /api/site-config` 确认无敏感字段泄漏（不能出现 JWT_SECRET / R2 密钥 / 后台路径）。

---

## 九、Phase D —— 一键开通（`provision-school.sh`）

```bash
./provision-school.sh --id <schoolId> --name "<校名>" --domain <host> [--deploy]
```

不加 `--deploy` 只做**本地生成**（自动生成 config / keystore / TWA school.json / 部署清单）；加 `--deploy` 才动远程。常用参数：`--short --abbr --email --theme --logo-text --slogan --boards <file> --no-classes --package --port --target --skip-apk --skip-domain --skip-backup --skip-install --force`。

**本地产物**：`~/phewall-provision/<id>/`（site.config.json、keystore 归档、`deploy-manifest.md`）+ `~/phewall-twa/schools/<id>/school.json`。

**远程布局**（每校独立）：`/root/phewall-<id>/`（代码 + 独立 data.db + ecosystem）、pm2 进程 `phewall-<id>`、R2 键前缀 `<id>/`（备份 `backups/<id>/`）。

**服务端助手** `scripts/provision-remote.sh`（由主脚本 SSH 调起，也可手动跑）：
- `install <id> <port> <adminPath>` —— 从 `/root/.r2-env`（自动从现有实例抽取，600）注入凭据写 ecosystem
- `domain <id> <host> <port> <zone>` —— 幂等插入 Cloudflare Tunnel ingress（404 前）+ 建 DNS CNAME（`<tunnel>.cfargotunnel.com`, proxied）
- `backup <id>` —— 生成 `/root/.backup-key-<id>` + `/root/backup-<id>.sh` + crontab（每天 03:05 UTC）

**白标化收口（Phase D 新增）**：
- `GET /manifest.json` 改为**动态生成**（name/short_name/description/id/theme_color 读 config），不再静态写死华普
- `GET /` 注入实例的后台路径：把 index.html 里写死的 `/manage-<hash>` 替换为 `siteConfig.adminPath`（正则替换，华普结果不变）
- `server/storage.js` 支持 `storage.keyPrefix`（多校共用桶的对象键隔离；空=原行为）
- `scripts/backup-site.js` 通用加密备份（R2 凭据走环境变量，密钥走文件，不写死）

**安全**：绝不触碰华普实例的 data.db / keystore；`--id phe` 直接拒绝；远程操作全部幂等（ingress/crontab/DNS 先查后加）。
