// ===== 白标化 · 通用站点备份（Phase D）=====
// 把某个学校实例的 data.db 加密后上传到 R2，并清理旧份。
//
// 用法（须能 require 到项目依赖，通常在实例目录内跑）：
//   node scripts/backup-site.js --dir /root/phewall-demo --prefix backups/demo/ --key /root/.backup-key-demo
//
// 参数：
//   --dir    实例根目录（默认 /root/phewall；data.db 在其下）
//   --prefix R2 对象键前缀（默认 backups/）
//   --keep   保留份数（默认 7）
//   --key    加密密钥文件（默认 /root/.backup-key）
//   --bucket R2 桶名（默认取 site.config.json 的 storage.bucket 或 phewall-media）
//
// 凭据（R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）从环境变量读取；
// cron 场景用 `. /root/.r2-env` 注入，绝不把密钥写进本文件。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DIR = arg('dir', '/root/phewall');
const PREFIX = arg('prefix', 'backups/');
const KEEP = Number(arg('keep', '7'));
const KEY_FILE = arg('key', '/root/.backup-key');

const DB_PATH = path.join(DIR, 'data.db');
if (!fs.existsSync(DB_PATH)) {
  console.error('[backup-site] 找不到数据库 ' + DB_PATH);
  process.exit(1);
}
if (!fs.existsSync(KEY_FILE)) {
  console.error('[backup-site] 缺少密钥文件 ' + KEY_FILE);
  process.exit(1);
}

// 桶名：优先参数/env → site.config.json storage.bucket → 默认
let bucket = arg('bucket', process.env.R2_BUCKET || '');
if (!bucket) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'site.config.json'), 'utf8'));
    bucket = (cfg.storage && cfg.storage.bucket) || 'phewall-media';
  } catch (_) { bucket = 'phewall-media'; }
}
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
if (!R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  console.error('[backup-site] 缺少 R2 凭据（先 source /root/.r2-env）');
  process.exit(1);
}

const Database = require(path.join(DIR, 'node_modules', 'better-sqlite3'));
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require(path.join(DIR, 'node_modules', '@aws-sdk/client-s3'));

const siteName = path.basename(DIR);
const s3 = new S3Client({
  region: 'auto',
  endpoint: 'https://' + R2_ACCOUNT_ID + '.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

(async () => {
  const date = new Date().toISOString().slice(0, 10);
  const tmp = '/tmp/' + siteName + '-' + date + '.db';
  const enc = tmp + '.enc';

  const db = new Database(DB_PATH);
  await db.backup(tmp);
  db.close();

  execFileSync('openssl', ['enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '200000',
    '-pass', 'file:' + KEY_FILE, '-in', tmp, '-out', enc]);

  const key = PREFIX.replace(/\/+$/, '') + '/' + siteName + '-' + date + '.db.enc';
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fs.createReadStream(enc),
    ContentType: 'application/octet-stream',
  }));
  console.log('[backup-site] 已上传（加密） ' + key);

  const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX }));
  const encs = (list.Contents || []).map(o => o.Key).filter(k => k.endsWith('.db.enc')).sort();
  while (encs.length > KEEP) {
    const old = encs.shift();
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: old }));
    console.log('[backup-site] 清理旧备份 ' + old);
  }

  for (const f of [tmp, enc]) { try { fs.unlinkSync(f); } catch (_) {} }
})().catch(e => { console.error('[backup-site] 备份失败: ' + e.message); process.exit(1); });
