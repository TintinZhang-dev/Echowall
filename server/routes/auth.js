const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const points = require('../points');
const { JWT_SECRET, getTokenFromReq, cookieOptions } = require('../auth-helper');

// ===== Auth Middleware =====
function auth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    // Check if user is banned
    const user = db.prepare('SELECT is_banned, banned_until, ban_reason FROM users WHERE id = ?').get(decoded.userId);
    if (user && user.is_banned) {
      if (user.banned_until) {
        const until = new Date(user.banned_until + 'Z');
        if (new Date() < until) {
          const untilStr = until.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
          return res.status(403).json({
            error: `账号已被封禁至 ${untilStr}，原因：${user.ban_reason || '占用他人姓名'}`
          });
        } else {
          // Ban expired, unban automatically
          db.prepare('UPDATE users SET is_banned = 0, banned_until = NULL, ban_reason = \'\' WHERE id = ?').run(decoded.userId);
        }
      } else {
        return res.status(403).json({
          error: `账号已被永久封禁，原因：${user.ban_reason || '占用他人姓名'}`
        });
      }
    }

    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// Optional auth: attaches user if token is present, but doesn't reject
function optionalAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch {
      // Token invalid, just continue without user
    }
  }
  next();
}

// Enrich a user row with level info + pin quota for API responses
function userWithLevel(u) {
  if (!u) return u;
  const info = points.getLevelInfo(u.level || 1);
  const quota = points.pinQuotaFor(u.level || 1);
  return {
    ...u,
    points: u.points || 0,
    level: u.level || 1,
    level_name: info.name,
    level_color: info.color,
    level_emoji: info.emoji,
    nickname_color: u.nickname_color || '',
    font_size: u.font_size || 'medium',
    streak_days: u.streak_days || 0,
    pin_quota: quota ? { duration_hours: quota.durationHours, period: quota.period, max: quota.max } : null,
  };
}

// ===== POST /api/auth/register =====
router.post('/register', (req, res) => {
  try {
    const { year, class_number, name, password, nickname, is_external, school } = req.body;
    const external = is_external === true || is_external === 1 || is_external === '1' || is_external === 'true';

    // Agreement check (required)
    if (!req.body.agree) {
      return res.status(400).json({ error: '请先阅读并同意《社区规则协议》' });
    }
    // Cross-border data storage consent (PIPL 39) — required at registration
    if (!req.body.data_consent) {
      return res.status(400).json({ error: '请阅读并同意数据存储地告知（信息存储于境外服务器）' });
    }

    // Validate required fields
    if (!name || !password) {
      return res.status(400).json({ error: external ? '用户名和密码为必填项' : '届、姓名和密码为必填项' });
    }

    if (!password || password.length < 4) {
      return res.status(400).json({ error: '密码至少需要4个字符' });
    }

    const yearNum = external ? 0 : parseInt(year);
    const classNum = external ? 0 : (class_number ? parseInt(class_number) : 0);

    if (!external && (isNaN(yearNum) || yearNum < 1 || yearNum > 99)) {
      return res.status(400).json({ error: '届必须是 1-99 的数字' });
    }
    if (!external && classNum > 0 && (isNaN(classNum) || classNum < 1 || classNum > 99)) {
      return res.status(400).json({ error: '班级必须是 1-99 的数字' });
    }
    if (external && !name.trim()) {
      return res.status(400).json({ error: '用户名不能为空' });
    }

    // Check uniqueness — external users are year=0, name=username; internal = same year + name
    let existing;
    if (external) {
      existing = db.prepare('SELECT id FROM users WHERE is_external = 1 AND name = ?').get(name.trim());
    } else {
      existing = db.prepare(
        'SELECT id FROM users WHERE year = ? AND name = ?'
      ).get(yearNum, name.trim());
    }

    if (existing) {
      return res.status(409).json({
        error: external ? '该用户名已被注册' : '该姓名已被注册，如有疑问请联系管理员申诉',
        canAppeal: !external
      });
    }

    // Hash password
    const passwordHash = bcrypt.hashSync(password, 10);

    // Create user
    const result = db.prepare(
      `INSERT INTO users (year, class_number, name, nickname, password_hash, agreed_terms_at, agreed_terms_version, data_consent_at, is_external, school)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?, datetime('now'), ?, ?)`
    ).run(yearNum, classNum, name.trim(), (nickname || '').trim(), passwordHash, TERMS_VERSION, external ? 1 : 0, external ? (school || '').trim() : '');

    // [2026-08-16] 积分系统：注册即视为当天首次登录，+2 分，连续登录从第 1 天起算
    db.prepare('UPDATE users SET last_login_date = ?, streak_days = 1 WHERE id = ?')
      .run(points.todayUTC(), result.lastInsertRowid);
    points.award(result.lastInsertRowid, 2, 'login');

    const user = db.prepare('SELECT id, year, class_number, name, nickname, bio, is_verified, is_admin, verified_label, created_at, is_external, school, points, level, nickname_color, font_size, streak_days FROM users WHERE id = ?').get(result.lastInsertRowid);

    // Generate token
    const token = jwt.sign(
      { userId: user.id, year: user.year, class_number: user.class_number, name: user.name, is_external: user.is_external },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Send welcome + community rules notifications immediately after registration
    db.prepare('INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
      result.lastInsertRowid, 'system', '👋 欢迎来到 Phewall',
      '欢迎来到华二普陀校园墙！你可以匿名或实名发帖、评论、点赞、转发，在分区里找到同好。welcome 置顶帖会在你注册12小时后自动从置顶消失，但随时可以回来逛逛。有任何问题或建议，点💬给我留言，或发邮件 tinzhang3141@gmail.com。祝你玩得开心！—— 创始人 张希辰'
    );
    db.prepare('INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
      result.lastInsertRowid, 'system', '📜 请阅读《社区规则协议》',
      '本平台规则、你的权利与数据处理说明详见《社区规则协议》：https://phewall.com/terms 。要点：禁止辱骂/谣言/泄露他人隐私/广告；被举报5次自动隐藏；内容涉及你本人时举报（选"涉及自己"）立即隐藏；所有删帖/封禁均记录原因并公示；你享有数据导出与注销账号的权利。有疑问点💬给我留言。'
    );

    res.cookie('pw_token', token, cookieOptions(req));
    res.status(201).json({ user: userWithLevel(user), token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ===== POST /api/auth/login =====
router.post('/login', (req, res) => {
  try {
    const { year, class_number, name, password, is_external } = req.body;
    const external = is_external === true || is_external === 1 || is_external === '1' || is_external === 'true';

    if (!name || !password) {
      return res.status(400).json({ error: external ? '用户名和密码为必填项' : '届、姓名和密码为必填项' });
    }

    // Find user — external users login by username (year=0, is_external=1)
    let user;
    if (external) {
      user = db.prepare('SELECT * FROM users WHERE is_external = 1 AND name = ?').get(name.trim());
    } else {
      const yearNum = parseInt(year);
      const classNum = class_number ? parseInt(class_number) : 0;
      if (year === undefined || year === null || year === '') {
        return res.status(400).json({ error: '届、姓名和密码为必填项' });
      }
      // Find user — flexible class_number matching
      if (classNum > 0) {
        user = db.prepare(
          'SELECT * FROM users WHERE year = ? AND class_number = ? AND name = ?'
        ).get(yearNum, classNum, name.trim());
      } else {
        user = db.prepare(
          'SELECT * FROM users WHERE year = ? AND name = ? ORDER BY id DESC'
        ).get(yearNum, name.trim());
      }
    }

    if (!user) {
      return res.status(401).json({ error: '用户不存在或信息不匹配' });
    }

    // Check password
    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: '密码错误' });
    }

    // Agreement check (required)
    if (!req.body.agree) {
      return res.status(400).json({ error: '请先阅读并同意《社区规则协议》' });
    }
    // Record agreement time + version
    db.prepare("UPDATE users SET agreed_terms_at = COALESCE(agreed_terms_at, datetime('now')), agreed_terms_version = ? WHERE id = ?")
      .run(TERMS_VERSION, user.id);

    // Check if user is banned
    if (user.is_banned) {
      if (user.banned_until) {
        const until = new Date(user.banned_until + 'Z');
        if (new Date() < until) {
          const untilStr = until.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
          return res.status(403).json({
            error: `账号已被封禁至 ${untilStr}，原因：${user.ban_reason || '占用他人姓名'}`
          });
        } else {
          // Ban expired, unban
          db.prepare('UPDATE users SET is_banned = 0, banned_until = NULL, ban_reason = \'\' WHERE id = ?').run(user.id);
          user.is_banned = 0;
        }
      } else {
        return res.status(403).json({
          error: `账号已被永久封禁，原因：${user.ban_reason || '占用他人姓名'}`
        });
      }
    }

    // [2026-08-16] 积分系统：每日登录 +2，连续登录第 N 天 +N（N≤7），断签重置
    const today = points.todayUTC();
    const yesterday = points.yesterdayUTC();
    let streak = 1;
    let streakBonus = 0;
    if (user.last_login_date === today) {
      // 当天已登录过，不再重复加分
      streak = user.streak_days || 1;
    } else if (user.last_login_date === yesterday) {
      streak = Math.min((user.streak_days || 0) + 1, 7);
      points.award(user.id, 2, 'login');
      if (streak >= 2) streakBonus = streak;
    } else {
      // 断签（或首次登录）
      points.award(user.id, 2, 'login');
    }
    if (streakBonus > 0) {
      points.award(user.id, streakBonus, 'streak');
    }
    db.prepare('UPDATE users SET last_login_date = ?, streak_days = ? WHERE id = ?')
      .run(today, streak, user.id);

    // Re-fetch updated points/level
    const fresh = db.prepare('SELECT points, level, nickname_color, font_size, streak_days FROM users WHERE id = ?').get(user.id);
    user.points = fresh.points;
    user.level = fresh.level;
    user.nickname_color = fresh.nickname_color;
    user.font_size = fresh.font_size;
    user.streak_days = fresh.streak_days;

    // Generate token
    const token = jwt.sign(
      { userId: user.id, year: user.year, class_number: user.class_number, name: user.name, is_external: user.is_external || 0 },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('pw_token', token, cookieOptions(req));
    res.json({
      user: userWithLevel({
        id: user.id,
        year: user.year,
        class_number: user.class_number,
        name: user.name,
        nickname: user.nickname,
        bio: user.bio,
        is_verified: user.is_verified,
        is_admin: user.is_admin,
        role: user.role,
        is_banned: user.is_banned,
        avatar_type: user.avatar_type,
        avatar_url: user.avatar_url,
        created_at: user.created_at,
        is_external: user.is_external || 0,
        school: user.school || '',
        points: user.points,
        level: user.level,
        nickname_color: user.nickname_color,
        font_size: user.font_size,
        streak_days: user.streak_days
      }),
      token
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ===== POST /api/auth/logout — clear httpOnly cookie =====
router.post('/logout', (req, res) => {
  res.clearCookie('pw_token', { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
});

// Current terms version (bumped on agreement revision)
const TERMS_VERSION = 'PW-TERMS-2026-001 v1.5';

// ===== POST /api/auth/delete-account — delete account & anonymize content (PIPL 47) =====
router.post('/delete-account', auth, (req, res) => {
  try {
    const { password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (!password || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(400).json({ error: '密码错误，无法注销' });
    }
    // Delete avatar from R2 if exists
    if (user.avatar_url) {
      const { deleteFromR2 } = require('../storage');
      deleteFromR2(user.avatar_url).catch(() => {});
    }
    const uid = user.id;
    // Anonymize posts & comments (keep content, drop identity)
    db.prepare('UPDATE posts SET user_id = NULL, is_anonymous = 1 WHERE user_id = ?').run(uid);
    db.prepare('UPDATE comments SET user_id = NULL WHERE user_id = ?').run(uid);
    // Delete related personal data
    db.prepare('DELETE FROM likes WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM comment_likes WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM follows WHERE follower_id = ? OR following_id = ?').run(uid, uid);
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM messages WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM verification_requests WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM reports WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM comment_reports WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM point_logs WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    db.prepare('INSERT INTO admin_logs (action, target_type, target_id, detail) VALUES (?, ?, ?, ?)')
      .run('account_deleted', 'user', String(uid), '[系统] 用户主动注销账号，其帖子/评论已匿名化处理');
    res.clearCookie('pw_token', { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ===== GET /api/auth/export-data — export my data (user rights) =====
router.get('/export-data', auth, (req, res) => {
  try {
    const uid = req.user.userId;
    const user = db.prepare('SELECT id, year, class_number, name, nickname, bio, created_at, agreed_terms_at, agreed_terms_version FROM users WHERE id = ?').get(uid);
    const posts = db.prepare('SELECT id, content, category, is_anonymous, pinned, created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC').all(uid);
    const comments = db.prepare('SELECT id, post_id, content, created_at FROM comments WHERE user_id = ? ORDER BY created_at DESC').all(uid);
    res.json({ exported_at: new Date().toISOString(), user, posts, comments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ===== GET /api/auth/me =====
router.get('/me', auth, (req, res) => {
  try {
    const user = db.prepare(
      'SELECT id, year, class_number, name, nickname, bio, is_verified, is_admin, role, avatar_type, avatar_url, verified_label, created_at, is_external, school, profile_public, points, level, nickname_color, font_size, streak_days FROM users WHERE id = ?'
    ).get(req.user.userId);

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    res.json({ user: userWithLevel(user) });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ===== POST /api/auth/appeal =====
router.post('/appeal', (req, res) => {
  try {
    const { year, class_number, name, reason, appeal_type } = req.body;

    if (!year || !class_number || !name) {
      return res.status(400).json({ error: '届、班级和姓名为必填项' });
    }

    const yearNum = parseInt(year);
    const classNum = parseInt(class_number);
    const type = appeal_type === 'password_reset' ? 'password_reset' : 'name_dispute';

    db.prepare(
      'INSERT INTO appeals (year, class_number, name, reason, appeal_type) VALUES (?, ?, ?, ?, ?)'
    ).run(yearNum, classNum, name.trim(), (reason || '').trim(), type);

    res.status(201).json({ message: '申诉已提交，等待管理员审核。审核结果将通过通知告知。' });
  } catch (err) {
    console.error('Appeal error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ===== POST /api/auth/verify-request =====
router.post('/verify-request', auth, (req, res) => {
  try {
    const { org_name, role, reason } = req.body;

    if (!org_name) {
      return res.status(400).json({ error: '组织名称为必填项' });
    }

    // Check if user already has a pending request
    const existing = db.prepare(
      'SELECT id FROM verification_requests WHERE user_id = ? AND status = ?'
    ).get(req.user.userId, 'pending');
    if (existing) {
      return res.status(409).json({ error: '你已提交认证申请，请等待审核' });
    }

    // Check if user already verified
    const user = db.prepare('SELECT verified_label FROM users WHERE id = ?').get(req.user.userId);
    if (user && user.verified_label) {
      return res.status(409).json({ error: '你的账号已认证' });
    }

    db.prepare(
      'INSERT INTO verification_requests (user_id, org_type, org_name, role, reason) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.userId, 'general', org_name.trim(), (role || '').trim(), (reason || '').trim());

    res.status(201).json({ message: '认证申请已提交，请等待管理员审核' });
  } catch (err) {
    console.error('Verify request error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
module.exports.auth = auth;
module.exports.optionalAuth = optionalAuth;
