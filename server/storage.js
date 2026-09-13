const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const { siteConfig } = require('./config');

// ===== 白标化 · R2 隔离（Phase D）=====
// 优先级：环境变量 → site.config.json 的 storage 块 → 内置默认值（兼容华普原有行为）。
// keyPrefix 让多校共用一个桶而互不干扰（对象键加前缀，公共 URL 带前缀）。
// 华普的 site.config.json 不写 storage（或 keyPrefix 为空）→ 行为与改造前完全一致。
const storageCfg = (siteConfig && siteConfig.storage) || {};
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || storageCfg.accountId || 'a618b2b25f57d1450d66ad9fc3b1bd73';
const R2_BUCKET = process.env.R2_BUCKET || storageCfg.bucket || 'phewall-media';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || storageCfg.publicUrl || `https://pub-322f78eafc9a40ac9cc3e5df9db92bf8.r2.dev`).replace(/\/+$/, '');
const KEY_PREFIX = String(storageCfg.keyPrefix || '').replace(/^\/+|\/+$/g, '');

// 对象键：加校前缀（无前缀则原样）
function applyPrefix(key) {
  return KEY_PREFIX ? `${KEY_PREFIX}/${key}` : key;
}
// 公共 URL：R2_PUBLIC_URL + 完整对象键
function publicUrlOf(key) {
  return `${R2_PUBLIC_URL}/${applyPrefix(key)}`;
}

if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  console.error('[storage] ⚠️ R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY 未配置，上传功能将不可用！');
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});

// Store in memory, upload to R2
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB [2026-08-09] 从 50MB 下调，防 OOM
  fileFilter: (req, file, cb) => {
    // [2026-08-31] 增加 .docx（Word 文档附件），拒绝 .doc/.docm 等可能带宏的格式
    const allowed = /\.(jpg|jpeg|png|gif|webp|mp4|webm|mov|avi|docx)$/i;
    if (allowed.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type'));
    }
  }
});

// Detect real file type from magic bytes (server-side content validation)
function sniffFileType(buf) {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  // WEBP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  // MP4: ....ftyp
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4';
  // WEBM/MKV: 1A 45 DF A3
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'video/webm';
  return null;
}

const EXT_MAP = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx'
};

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// [2026-08-31] Word 文档校验（防宏病毒）
// 仅接受 .docx（OOXML zip 包）。检查：
//  1) 魔数必须是 zip（PK\x03\x04）——伪造扩展名直接拒绝
//  2) 包内必须有 [Content_Types].xml + word/document.xml（确实是 Word 文档）
//  3) 包内不得有 vbaProject.bin / vbaData.xml（VBA 宏）或 word/activeX（ActiveX 控件）
// 返回 { ok: true } 或 { error: 'macro' | 'not-docx' }
function sniffDocx(buf) {
  if (!buf || buf.length < 8) return { error: 'not-docx' };
  // ZIP 魔数 PK\x03\x04；PK\x05\x06 = 空压缩包
  if (!(buf[0] === 0x50 && buf[1] === 0x4B)) return { error: 'not-docx' };
  if (buf[2] === 0x05 && buf[3] === 0x06) return { error: 'not-docx' };
  const hasContentTypes = buf.includes(Buffer.from('[Content_Types].xml'));
  const hasDocument = buf.includes(Buffer.from('word/document.xml'));
  if (!hasContentTypes || !hasDocument) return { error: 'not-docx' };
  if (buf.includes(Buffer.from('vbaProject.bin'))) return { error: 'macro' };
  if (buf.includes(Buffer.from('word/vbaData.xml'))) return { error: 'macro' };
  if (buf.includes(Buffer.from('word/activeX'))) return { error: 'activex' };
  return { ok: true };
}

// 清理文件名：只保留安全字符，防 Content-Disposition 注入
function sanitizeFilename(name) {
  const base = String(name || 'document.docx').replace(/[\r\n\"/\\<>:*?|]/g, '_').trim();
  return base.length > 80 ? base.slice(0, 80) + '.docx' : base;
}

async function uploadToR2(file, customKey, opts) {
  // ContentType derived from sniffed content, never trust client mimetype
  let type = file.sniffedType || sniffFileType(file.buffer) || 'application/octet-stream';
  let disposition = null;
  if (opts && opts.contentType) type = opts.contentType;
  if (opts && opts.contentDisposition) disposition = opts.contentDisposition;
  const ext = EXT_MAP[type] || 'bin';
  const rawKey = customKey || `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;
  const key = applyPrefix(rawKey);

  const putParams = {
    Bucket: R2_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: type,
    ACL: 'public-read',
  };
  if (disposition) putParams.ContentDisposition = disposition;

  await s3.send(new PutObjectCommand(putParams));

  return `${R2_PUBLIC_URL}/${key}`;
}

async function deleteFromR2(url) {
  if (!url || !url.includes(R2_PUBLIC_URL)) return;
  // 保留完整对象键（含校前缀）；旧数据（无前缀）也能正确解析
  const key = url.slice(url.indexOf(R2_PUBLIC_URL) + R2_PUBLIC_URL.length + 1);
  if (!key) return;
  await s3.send(new DeleteObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
  }));
}

module.exports = { upload, uploadToR2, deleteFromR2, sniffFileType, sniffDocx, sanitizeFilename, DOCX_MIME };
