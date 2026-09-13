# EchoWall · 回声墙

> 每所学校都该有的墙 —— 一套可白标化（white-label）快速复制的校园匿名交流墙。
>
> 🔗 **在线预览（落地页）**：https://tintinzhang-dev.github.io/Echowall/

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-ready-5A0FC8?logo=pwa&logoColor=white)
![PRs](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

EchoWall 是一个面向中学的校园社区平台：文字 / 图片 / 视频 / Word 投稿、点赞、评论、转发、关注、私信、分区板块、积分等级、举报与申诉审核、管理后台……**同一套代码，通过一份 `site.config.json` 就能变成任意一所学校自己的墙**（自己的名字、Logo、主题色、域名、数据隔离、独立签名 APK）。

> 现网实例：华二普陀校园墙 <https://phewall.com>

## ✨ 功能

- **发帖/评论/点赞/转发/关注/私信** —— 匿名或实名，@提及与通知
- **分区板块** —— 板块列表由配置驱动（registry.boards）
- **积分等级** —— 仿 B 站经验值：登录/发帖/评论/获赞/被关注得分，防刷上限 + 可审计流水；等级解锁彩色昵称、置顶等特权
- **内容治理** —— 举报（按账号去重 + 5 次自动隐藏）、申诉、IP 封禁、管理员操作日志
- **账号体系** —— JWT（httpOnly cookie）、可选"届/班"体系开关（`school.hasClassSystem`）
- **媒体存储** —— Cloudflare R2（对象键前缀按校隔离），Word 附件三层防宏校验
- **PWA + 安卓 App** —— 网页可"添加到主屏幕"；每校独立包名/图标/签名 keystore 的 TWA APK
- **一键开通** —— `provision-school.sh` 从校名/域名生成配置、keystore、APK、部署清单

## 🏗️ 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 纯 HTML / CSS / JS（无框架） |
| 后端 | Node.js + Express |
| 数据库 | SQLite（better-sqlite3，WAL） |
| 存储 | Cloudflare R2（S3 兼容） |
| 部署 | Cloudflare Tunnel + pm2，无公网端口 |
| 移动端 | Bubblewrap 构建 TWA（Android） |

## 🚀 本地运行

```bash
npm install
cp site.config.example.json site.config.json   # 按需修改
npm run init-site                               # 初始化板块 + 欢迎帖（幂等）
JWT_SECRET=dev-secret npm start                 # http://localhost:3000
```

> 生产环境**必须**设置 `JWT_SECRET`，否则拒绝启动。R2 相关上传需 `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`。

## 🧩 白标化：为新学校开通一个实例

```bash
./provision-school.sh --id <schoolId> --name "<校名>" --domain <域名> [--deploy]
```

不加 `--deploy` 只做本地生成（config + 独立 keystore + TWA school.json + 部署清单）；加 `--deploy` 才动服务器（建目录 / 同步代码 / 初始化 / pm2 / Cloudflare Tunnel ingress + DNS / 加密备份）。

配置项见 `site.config.example.json` 与 `docs/whitelabel.md`。

## 📄 许可证

[MIT](LICENSE)
