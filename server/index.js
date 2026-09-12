const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const points = require('./points');
const { upload } = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Force HTTPS redirect (behind Cloudflare Tunnel) =====
app.use((req, res, next) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  if (proto !== 'https' && req.method === 'GET') {
    // Only redirect GET requests; keep API POSTs working over http locally
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});

// ===== Security Headers =====
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ===== Rate Limiting =====

// General API limiter: 100 requests per 15 min per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.socket?.remoteAddress ||
           '127.0.0.1';
  }
});

// Auth limiter: 10 attempts per 15 min per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: '登录尝试过于频繁，请 15 分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.socket?.remoteAddress ||
           '127.0.0.1';
  }
});

// Register limiter: 3 per hour per IP
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: '注册过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.socket?.remoteAddress ||
           '127.0.0.1';
  }
});

// Post creation limiter: 20 per hour per IP (POST only, GET not affected)
const postCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: '发帖过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.socket?.remoteAddress ||
           '127.0.0.1';
  }
});

// Rate limit master switch (testing: set RATE_LIMIT_DISABLED=1)
const rateLimitDisabled = process.env.RATE_LIMIT_DISABLED === '1';
const skip = (req, res, next) => next();

// Apply global limiter to all /api routes
app.use('/api', rateLimitDisabled ? skip : apiLimiter);

// Static files
// APK 下载不缓存（防止手机拿到旧版本）——必须在 express.static 之前注册
app.use('/downloads', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: false, // 不自动吐 index.html,让 / 走登录门禁后由显式路由服务
  etag: true,
  setHeaders: (res) => {
    // 静态资源始终回源校验(ETag 304/200),配合 HTML 里的 ?v= 版本号,部署后用户自动拿到新版,无需手动刷新
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

// ===== 登录门禁 Login Gate (2026-09-05) =====
// LOGIN_GATE=on 时启用:未登录用户不能浏览校园墙(隐私保护),9/12 正式生效
// 放行:登录/注册/申诉/条款/APK下载页/管理后台登录/站点文件 + /api/auth/* 与 /api/admin/login
// 其余页面 → 302 到 /login?next=...,其余 /api → 401 { code: 'LOGIN_REQUIRED' }
const { getUserFromReq } = require('./auth-helper');
const LOGIN_GATE = process.env.LOGIN_GATE === 'on';
app.use((req, res, next) => {
  if (!LOGIN_GATE) return next();
  if (getUserFromReq(req)) return next(); // 已登录(含 admin/founder,同一 pw_token)
  const p = req.path;
  // 游客可访问的页面
  if (p === '/login' || p === '/register' || p === '/reset-password' || p === '/appeal' ||
      p === '/terms' || p === '/guide' || p === '/app' || p === '/app/' || p === '/download' ||
      p === '/diag' || p === '/security.txt' || p === '/robots.txt' || p === '/favicon.ico' ||
      p.startsWith('/downloads/') || p.startsWith('/manage-') || p.startsWith('/.well-known/')) {
    return next();
  }
  // 游客可访问的 API(登录/注册/登出/申诉/密码重置都在 /api/auth 下,后台登录单独放行)
  if (p.startsWith('/api/auth/') || p === '/api/admin/login' || p === '/api/debug' || p === '/api/app/version') {
    return next();
  }
  if (p.startsWith('/api/')) {
    return res.status(401).json({ error: '请先登录后再浏览校园墙', code: 'LOGIN_REQUIRED' });
  }
  // 内容页面:带去登录页,登录后回跳
  return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
});

// 首页(登录门禁之后才到这里;未登录已在门禁被重定向到 /login)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Clean URLs — serve .html without extension
const pages = ['login', 'register', 'settings', 'appeal', 'reset-password', 'notifications', 'terms', 'guide', 'boards', 'board', 'dm', 'app'];
// /download → 安卓 App 下载（重定向到 App 页）
app.get('/download', (req, res) => {
  res.redirect(301, '/app');
});
pages.forEach(p => {
  app.get(`/${p}`, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', `${p}.html`));
  });
  app.get(`/${p}.html`, (req, res) => {
    res.redirect(301, `/${p}`);
  });
});

// Android TWA Digital Asset Links (无地址栏全屏体验验证)
app.get('/.well-known/assetlinks.json', (req, res) => {
  const assetlinks = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.phewall.app',
        sha256_cert_fingerprints: ['F8:24:0F:7F:1A:59:CF:21:D2:6F:E1:ED:8F:27:5A:6F:83:4C:3F:56:34:EB:99:24:D9:9F:28:92:BB:2D:BB:E8']
      }
    }
  ];
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(assetlinks));
});

// Admin page — configurable path via ADMIN_PATH env var
const adminPath = process.env.ADMIN_PATH || '/admin';
app.get(adminPath, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});
// Keep /admin.html redirect for legacy bookmarks
// Hide admin path — only serve at custom ADMIN_PATH when set
app.get('/admin', (req, res) => {
  const dest = process.env.ADMIN_PATH;
  if (dest) {
    return res.status(404).send('Not Found');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.get('/admin.html', (req, res) => {
  const dest = process.env.ADMIN_PATH;
  if (dest) {
    return res.status(404).send('Not Found');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// Make upload available to routes
app.locals.upload = upload;
app.locals.storage = require('./storage');

// Post detail page — dynamic route
app.get('/post/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'post.html'));
});

// Serve uploaded files (legacy — local dev only)
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Mount routes with specific rate limiters
app.use('/api/auth/login', rateLimitDisabled ? skip : authLimiter);
app.use('/api/auth/register', rateLimitDisabled ? skip : registerLimiter);
app.use('/api/auth', require('./routes/auth'));
// Apply POST creation limiter (only affects POST, GET stays free)
app.post('/api/posts', rateLimitDisabled ? skip : postCreationLimiter);

app.use('/api/posts', require('./routes/posts'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/user/avatar', require('./routes/avatar'));
app.use('/api/user', require('./routes/user'));
app.use('/api/search', require('./routes/search'));
app.use('/api/follow', require('./routes/follow'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/boards', require('./routes/boards'));
app.use('/api/dm', require('./routes/dm'));
app.use('/api/points', require('./routes/points'));

// Debug error logging (client-side JS errors from iOS etc.)
app.post('/api/debug', (req, res) => {
  try {
    const line = '[' + new Date().toISOString() + '] ' + (req.body && req.body.ua ? req.body.ua.slice(0, 120) : '') + ' | ' + (req.body && req.body.msg ? String(req.body.msg).slice(0, 300) : '') + ' | ' + (req.body && req.body.src ? String(req.body.src).slice(0, 200) : '') + ' | ' + (req.body && req.body.stack ? String(req.body.stack).slice(0, 800) : '');
    require('fs').appendFileSync('/root/phewall/debug-errors.log', line + '\n');
  } catch (_) {}
  res.json({ ok: true });
});

// Latest Android APK version (in-app update check; needs to work for logged-out App users)
app.get('/api/app/version', (req, res) => {
  try {
    const dir = path.join(__dirname, '..', 'public', 'downloads');
    const files = require('fs').readdirSync(dir).filter(f => /^Phewall-v[\d.]+\.apk$/.test(f));
    let best = null; // { parts:[n,n,n], file }
    files.forEach(f => {
      const parts = f.match(/^Phewall-v([\d.]+)\.apk$/)[1].split('.').map(Number);
      if (!best) { best = { parts, file: f }; return; }
      for (let i = 0; i < Math.max(parts.length, best.parts.length); i++) {
        const a = parts[i] || 0, b = best.parts[i] || 0;
        if (a > b) { best = { parts, file: f }; return; }
        if (a < b) return;
      }
    });
    if (!best) return res.json({ version: null, url: null });
    res.json({ version: best.parts.join('.'), url: '/downloads/' + best.file });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// Serve search and user pages
app.get('/search', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'search.html')); });
app.get('/user/:id', (req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'user.html')); });

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ===== Onboarding posts auto-delete (12h after first registration) =====
function deleteScheduledPosts() {
  try {
    const due = db.prepare("SELECT id FROM posts WHERE scheduled_delete_at IS NOT NULL AND scheduled_delete_at < datetime('now')").all();
    if (!due.length) return;
    const del = db.prepare('DELETE FROM posts WHERE id = ?');
    const delCommentLikes = db.prepare('DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE post_id = ?)');
    const delComments = db.prepare('DELETE FROM comments WHERE post_id = ?');
    const delLikes = db.prepare('DELETE FROM likes WHERE post_id = ?');
    const delReports = db.prepare('DELETE FROM reports WHERE post_id = ?');
    const delCommentReports = db.prepare('DELETE FROM comment_reports WHERE comment_id IN (SELECT id FROM comments WHERE post_id = ?)');
    const log = db.prepare("INSERT INTO admin_logs (action, target_type, target_id, detail) VALUES (?, ?, ?, ?)");
    for (const row of due) {
      // [2026-08-31] 撤销积分（新人引导帖作者也拿过发帖分）
      const full = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(row.id);
      const comments = db.prepare('SELECT id, user_id FROM comments WHERE post_id = ?').all(row.id);
      delCommentLikes.run(row.id); delComments.run(row.id); delLikes.run(row.id);
      delReports.run(row.id); delCommentReports.run(row.id); del.run(row.id);
      if (full && full.user_id) points.revoke(full.user_id, 'post', row.id);
      for (const c of comments) {
        if (c.user_id) points.revoke(c.user_id, 'comment', c.id);
      }
      log.run('auto_delete_post', 'post', String(row.id), '[系统] 新用户注册12小时期限已到，新人引导帖自动删除');
    }
    console.log(`[cleanup] deleted ${due.length} scheduled post(s)`);
  } catch (err) {
    console.error('[cleanup] error:', err.message);
  }
}
// Run on startup + every 15 minutes
deleteScheduledPosts();
setInterval(deleteScheduledPosts, 15 * 60 * 1000);
// ===== Pin expiry auto-unpin (every 15 min) =====
function unpinExpiredPosts() {
  try {
    const due = db.prepare("SELECT id FROM posts WHERE pinned = 1 AND pin_expires_at IS NOT NULL AND pin_expires_at < datetime('now')").all();
    if (!due.length) return;
    const upd = db.prepare('UPDATE posts SET pinned = 0, pin_expires_at = NULL WHERE id = ?');
    const log = db.prepare("INSERT INTO admin_logs (action, target_type, target_id, detail) VALUES (?, ?, ?, ?)");
    for (const row of due) {
      upd.run(row.id);
      log.run('auto_unpin_post', 'post', String(row.id), '[系统] 置顶到期自动取消');
    }
    console.log(`[cleanup] auto-unpinned ${due.length} post(s)`);
  } catch (err) {
    console.error('[cleanup] unpin error:', err.message);
  }
}
unpinExpiredPosts();
setInterval(unpinExpiredPosts, 15 * 60 * 1000);

// ===== 积分系统：周/日置顶次数重置（每周一重置 weekly_pin_used，跨天重置 daily_pin_used） =====
function resetPinCounters() {
  try {
    const today = points.todayUTC();
    const week = points.weekStr();
    db.prepare('UPDATE users SET weekly_pin_used = 0, weekly_pin_week = ? WHERE weekly_pin_week != ? AND weekly_pin_used > 0').run(week, week);
    db.prepare('UPDATE users SET daily_pin_used = 0, daily_pin_date = ? WHERE daily_pin_date != ? AND daily_pin_used > 0').run(today, today);
  } catch (err) {
    console.error('[reset] pin counter error:', err.message);
  }
}
resetPinCounters();
setInterval(resetPinCounters, 60 * 60 * 1000);


app.listen(PORT, '0.0.0.0', () => {
  console.log(`Phewall running on http://0.0.0.0:${PORT}`);
});
