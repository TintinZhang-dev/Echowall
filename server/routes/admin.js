const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const points = require('../points');
const { deleteFromR2 } = require('../storage');
const { JWT_SECRET, getTokenFromReq, cookieOptions } = require('../auth-helper');
const { siteConfig } = require('../config');

// Auth middleware — pure JWT user-based auth
function auth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) {
    return res.status(401).json({ error: '未授权：请先登录' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, name, nickname, role FROM users WHERE id = ?').get(decoded.userId);
    if (!user || (user.role !== 'admin' && user.role !== 'founder')) {
      return res.status(403).json({ error: '权限不足，需要管理员权限' });
    }
    req.isFounder = user.role === 'founder';
    req.adminName = user.nickname || user.name;
    req.adminUserId = user.id;
    next();
  } catch {
    return res.status(401).json({ error: '未授权：令牌无效或已过期，请重新登录' });
  }
}

// POST /api/admin/login — Login as admin with username/password (no auth required)
router.post('/login', (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) {
      return res.status(400).json({ error: '用户名和密码为必填项' });
    }
    const user = db.prepare("SELECT * FROM users WHERE name = ? AND (role = 'admin' OR role = 'founder')").get(name.trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const token = jwt.sign(
      { userId: user.id, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.cookie('pw_token', token, cookieOptions(req));
    res.json({
      token,
      adminName: user.nickname || user.name,
      role: user.role,
      isFounder: user.role === 'founder'
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// All routes require auth
router.use(auth);

// Helper: attach adminLog function to req
router.use((req, res, next) => {
  const who = req.adminName || '系统';
  req.adminLog = (action, targetType, targetId, detail) => {
    db.prepare('INSERT INTO admin_logs (action, target_type, target_id, detail) VALUES (?, ?, ?, ?)').run(
      action, targetType, targetId, `[${who}] ${detail}`
    );
  };
  next();
});
// POST /api/admin/posts/:id/pin — Toggle pin
router.post('/posts/:id/pin', (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const post = db.prepare('SELECT id, pinned, user_id FROM posts WHERE id = ?').get(postId);
    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    const { expiresInHours } = req.body || {};
    const newPinned = post.pinned ? 0 : 1;
    let pinExpires = null;
    if (newPinned && expiresInHours && parseInt(expiresInHours) > 0) {
      pinExpires = db.prepare("SELECT datetime('now', ?) as t").get('+' + parseInt(expiresInHours) + ' hours').t;
    }
    db.prepare('UPDATE posts SET pinned = ?, pin_expires_at = ? WHERE id = ?').run(newPinned, pinExpires, postId);

    // Get author name for log
    const pinAuthor = post.user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(post.user_id) : null;
    const pinAuthorName = pinAuthor ? `（作者：${pinAuthor.name}）` : '';

    req.adminLog(
      newPinned ? 'pin_post' : 'unpin_post', 'post', String(postId),
      newPinned ? `置顶帖子 #${postId}\${pinAuthorName}` : `取消置顶帖子 #${postId}\${pinAuthorName}`
    );

    if (post.user_id) {
      const actionLabel = newPinned ? '已被置顶' : '已被取消置顶';
      db.prepare(
        'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
      ).run(post.user_id, newPinned ? 'post_pinned' : 'post_unpinned',
        newPinned ? '帖子被置顶' : '帖子取消置顶',
        `你的帖子 #${postId} ${actionLabel}`);
    }

    res.json({ pinned: !!newPinned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/posts/:id/hide — Toggle hide
router.post('/posts/:id/hide', (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const post = db.prepare('SELECT id, hidden, user_id FROM posts WHERE id = ?').get(postId);
    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    const newHidden = post.hidden ? 0 : 1;
    db.prepare('UPDATE posts SET hidden = ? WHERE id = ?').run(newHidden, postId);

    const hideAuthor = post.user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(post.user_id) : null;
    const hideAuthorName = hideAuthor ? `（作者：${hideAuthor.name}）` : '';

    req.adminLog(
      newHidden ? 'hide_post' : 'unhide_post', 'post', String(postId),
      newHidden ? `隐藏帖子 #${postId}\${hideAuthorName}` : `取消隐藏帖子 #${postId}\${hideAuthorName}`
    );

    if (post.user_id) {
      const actionLabel = newHidden ? '已被管理员隐藏' : '已被管理员取消隐藏';
      db.prepare(
        'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
      ).run(post.user_id, newHidden ? 'post_hidden' : 'post_unhidden',
        newHidden ? '帖子被隐藏' : '帖子已恢复',
        `你的帖子 #${postId} ${actionLabel}`);
    }

    res.json({ hidden: !!newHidden });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/posts/:id/delete — Delete a post (physical delete)
router.post('/posts/:id/delete', async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const post = db.prepare('SELECT id, content, user_id, media_url, media_urls, docx_url FROM posts WHERE id = ?').get(postId);
    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    if (post.user_id) {
      db.prepare(
        'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
      ).run(post.user_id, 'post_deleted', '帖子已被删除',
        `你的帖子 #${postId} 已被管理员删除`);
    }

    // [2026-08-31] 先记录文件 URL
    const docxUrl = post.docx_url;
    const mediaUrls = [];
    if (post.media_url) mediaUrls.push(post.media_url);
    try { mediaUrls.push(...(JSON.parse(post.media_urls || '[]'))); } catch (_) {}
    const commentRows = db.prepare('SELECT id, user_id FROM comments WHERE post_id = ?').all(postId);

    db.prepare('DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE post_id = ?)').run(postId);
    db.prepare('DELETE FROM comments WHERE post_id = ?').run(postId);
    db.prepare('DELETE FROM likes WHERE post_id = ?').run(postId);
    db.prepare('DELETE FROM reports WHERE post_id = ?').run(postId);
    db.prepare('DELETE FROM comment_reports WHERE comment_id IN (SELECT id FROM comments WHERE post_id = ?)').run(postId);
    db.prepare('DELETE FROM posts WHERE id = ?').run(postId);

    // [2026-08-31] 撤销积分 + 清理 R2 文件
    if (post.user_id) points.revoke(post.user_id, 'post', postId);
    for (const c of commentRows) {
      if (c.user_id) points.revoke(c.user_id, 'comment', c.id);
    }
    if (docxUrl) { try { await deleteFromR2(docxUrl); } catch (_) {} }
    for (const u of new Set(mediaUrls)) { try { await deleteFromR2(u); } catch (_) {} }

    const delAuthor = post.user_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(post.user_id) : null;
    const delAuthorName = delAuthor ? `（作者：${delAuthor.name}）` : '';
    req.adminLog('delete_post', 'post', String(postId), `删除帖子 #${postId}${delAuthorName}: ${(post.content || '').substring(0, 50)}`);

    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/admin/whoami — Check admin role
router.get('/whoami', (req, res) => {
  res.json({
    role: req.isFounder ? 'founder' : 'admin',
    isFounder: req.isFounder,
    adminName: req.adminName
  });
});

// GET /api/admin/reports — View reports (posts + comments)
router.get('/reports', (req, res) => {
  try {
    const postReports = db.prepare(`
      SELECT r.id, r.post_id, p.content as content, r.ip as report_ip, r.reason, r.created_at
      FROM reports r LEFT JOIN posts p ON r.post_id = p.id
      ORDER BY r.created_at DESC LIMIT 100
    `).all().map(r => ({ ...r, type: 'post', comment_id: null }));

    const commentReports = db.prepare(`
      SELECT r.id, r.comment_id, c.post_id, c.content as content, r.ip as report_ip, r.reason, r.created_at,
             c.user_id as cuser_id, u.nickname as cnickname, u.name as cname, c.is_anonymous as c_is_anonymous
      FROM comment_reports r LEFT JOIN comments c ON r.comment_id = c.id
      LEFT JOIN users u ON c.user_id = u.id
      ORDER BY r.created_at DESC LIMIT 100
    `).all().map(r => {
      const realName = r.c_is_anonymous ? `${r.cname || r.cnickname || '匿名'}（匿名评论）` : (r.cname || r.cnickname || '匿名');
      return { ...r, type: 'comment', comment_author: realName };
    });

    const reports = [...postReports, ...commentReports]
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 100);

    res.json({ reports });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/reports/:id/dismiss — Dismiss a report
router.post('/reports/:id/dismiss', (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    db.prepare('DELETE FROM reports WHERE id = ?').run(reportId);
    req.adminLog('dismiss_report', 'report', String(reportId), `忽略举报 #${reportId}`);
    res.json({ dismissed: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/comment-reports/:id/dismiss — Dismiss a comment report
router.post('/comment-reports/:id/dismiss', (req, res) => {
  try {
    const reportId = parseInt(req.params.id);
    db.prepare('DELETE FROM comment_reports WHERE id = ?').run(reportId);
    req.adminLog('dismiss_comment_report', 'report', String(reportId), `忽略评论举报 #${reportId}`);
    res.json({ dismissed: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/comments/:id/hide — Toggle comment hide
router.post('/comments/:id/hide', (req, res) => {
  try {
    const commentId = parseInt(req.params.id);
    const comment = db.prepare('SELECT id, hidden, user_id, post_id FROM comments WHERE id = ?').get(commentId);
    if (!comment) {
      return res.status(404).json({ error: '评论不存在' });
    }
    const newHidden = comment.hidden ? 0 : 1;
    db.prepare('UPDATE comments SET hidden = ? WHERE id = ?').run(newHidden, commentId);
    req.adminLog(newHidden ? 'hide_comment' : 'unhide_comment', 'comment', String(commentId),
      `${newHidden ? '隐藏' : '取消隐藏'}帖子 #${comment.post_id} 下的评论 #${commentId}`);
    res.json({ hidden: !!newHidden });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/admin/appeals — View appeals
router.get('/appeals', (req, res) => {
  try {
    const appeals = db.prepare(
      'SELECT * FROM appeals ORDER BY created_at DESC LIMIT 100'
    ).all();
    res.json({ appeals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/appeals/:id/approve — Approve an appeal (password_reset only)
router.post('/appeals/:id/approve', (req, res) => {
  try {
    const appealId = parseInt(req.params.id);
    const appeal = db.prepare('SELECT * FROM appeals WHERE id = ?').get(appealId);
    if (!appeal) return res.status(404).json({ error: '申诉不存在' });

    // Only password_reset appeals can be approved via this endpoint
    if (appeal.appeal_type === 'name_dispute') {
      return res.status(400).json({ error: '姓名占用申诉请联系管理员微信核实后手动处理' });
    }

    db.prepare('UPDATE appeals SET status = ? WHERE id = ?').run('approved', appealId);

    req.adminLog('approve_appeal', 'appeal', String(appealId), `通过申诉 #${appealId}: ${appeal.name} (${appeal.year}届${appeal.class_number}班)`);

    const user = db.prepare('SELECT id FROM users WHERE year = ? AND class_number = ? AND name = ?').get(appeal.year, appeal.class_number, appeal.name);
    if (user) {
      db.prepare(
        'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
      ).run(user.id, 'appeal_approved', '申诉已通过', `你的申诉已通过，现在可以正常登录。`);
    }

    res.json({ message: '申诉已通过' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/appeals/:id/approve-name-dispute — Handle name dispute (ban occupier + notify)
router.post('/appeals/:id/approve-name-dispute', (req, res) => {
  try {
    const appealId = parseInt(req.params.id);
    const appeal = db.prepare('SELECT * FROM appeals WHERE id = ?').get(appealId);
    if (!appeal) return res.status(404).json({ error: '申诉不存在' });

    if (appeal.appeal_type !== 'name_dispute') {
      return res.status(400).json({ error: '此接口仅用于姓名占用申诉' });
    }

    // Find the user currently occupying this name
    const occupier = db.prepare(
      'SELECT id, name FROM users WHERE year = ? AND class_number = ? AND name = ? AND id != (SELECT id FROM users WHERE year = ? AND class_number = ? AND name = ? ORDER BY id DESC LIMIT 1) ORDER BY id ASC LIMIT 1'
    ).get(appeal.year, appeal.class_number, appeal.name, appeal.year, appeal.class_number, appeal.name);

    // If no occupier found by complex logic, just find the first matching user
    // (the occupier is the existing user with this name who isn't the appellant)
    if (!occupier) {
      // Find the user(s) with this name. Ban the earliest registered one.
      const occupiers = db.prepare(
        'SELECT id, name FROM users WHERE year = ? AND class_number = ? AND name = ? ORDER BY id ASC'
      ).all(appeal.year, appeal.class_number, appeal.name);

      if (occupiers.length > 0) {
        // Ban the occupier's account and IP
        const targetUser = occupiers[0];
        db.prepare('UPDATE users SET is_banned = 1, banned_until = NULL, ban_reason = ? WHERE id = ?')
          .run(`占用他人姓名（申诉 #${appealId}: ${appeal.name}）`, targetUser.id);

        // Find and ban their IP from recent posts
        const recentPost = db.prepare(
          'SELECT ip FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
        ).get(targetUser.id);

        if (recentPost && recentPost.ip) {
          const existingBan = db.prepare('SELECT id FROM banned_ips WHERE ip = ?').get(recentPost.ip);
          if (!existingBan) {
            db.prepare('INSERT INTO banned_ips (ip, reason, banned_until) VALUES (?, ?, ?)').run(
              recentPost.ip,
              `占用他人姓名：${appeal.name} (${appeal.year}届${appeal.class_number}班)`,
              null  // permanent
            );
          }
        }

        // Notify the banned user（联系方式读 config；wechat 为空则去掉该句）
        const banContact = siteConfig.founder.wechat
          ? ' 如有疑问请联系管理员微信 ' + siteConfig.founder.wechat + '。'
          : '';
        db.prepare(
          'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
        ).run(targetUser.id, 'account_banned', '账号已被封禁',
          '你的账号因占用他人姓名已被封禁。' + banContact);
      }
    }

    db.prepare('UPDATE appeals SET status = ? WHERE id = ?').run('approved', appealId);

    req.adminLog('approve_appeal', 'appeal', String(appealId),
      `通过姓名占用申诉 #${appealId}: ${appeal.name} (${appeal.year}届${appeal.class_number}班)，已封禁占用者`);

    // Notify the appellant
    const appellant = db.prepare(
      'SELECT id FROM users WHERE year = ? AND class_number = ? AND name = ? ORDER BY id DESC LIMIT 1'
    ).get(appeal.year, appeal.class_number, appeal.name);

    if (appellant) {
      db.prepare(
        'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
      ).run(appellant.id, 'appeal_approved', '申诉已通过',
        `你的姓名占用申诉已通过，占用者已被封禁。你现在可以重新注册该姓名。`);
    }

    res.json({ message: '姓名占用申诉已处理，占用者已被封禁' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/appeals/:id/reject — Reject an appeal
router.post('/appeals/:id/reject', (req, res) => {
  try {
    const appealId = parseInt(req.params.id);
    const appeal = db.prepare('SELECT * FROM appeals WHERE id = ?').get(appealId);
    if (!appeal) return res.status(404).json({ error: '申诉不存在' });

    db.prepare('UPDATE appeals SET status = ? WHERE id = ?').run('rejected', appealId);

    req.adminLog('reject_appeal', 'appeal', String(appealId), `拒绝申诉 #${appealId}: ${appeal.name} (${appeal.year}届${appeal.class_number}班)`);

    const user = db.prepare('SELECT id FROM users WHERE year = ? AND class_number = ? AND name = ?').get(appeal.year, appeal.class_number, appeal.name);
    if (user) {
      db.prepare(
        'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
      ).run(user.id, 'appeal_rejected', '申诉已被拒绝', '你的申诉已被管理员拒绝。如有疑问请联系管理员。');
    }

    res.json({ message: '申诉已拒绝' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/appeals/:id/reset-password — Reset user password
router.post('/appeals/:id/reset-password', (req, res) => {
  try {
    const appealId = parseInt(req.params.id);
    const appeal = db.prepare('SELECT * FROM appeals WHERE id = ?').get(appealId);
    if (!appeal) return res.status(404).json({ error: '申诉不存在' });

    const newPassword = 'phe' + Math.random().toString(36).slice(2, 8);
    const hash = bcrypt.hashSync(newPassword, 10);

    const user = db.prepare('SELECT id FROM users WHERE year = ? AND class_number = ? AND name = ?').get(appeal.year, appeal.class_number, appeal.name);
    if (!user) return res.status(404).json({ error: '未找到对应用户' });

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);

    db.prepare(
      'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
    ).run(user.id, 'appeal_approved', '密码已重置', `你的密码已被管理员重置，新密码为：${newPassword}。请登录后尽快修改密码。`);

    db.prepare('UPDATE appeals SET status = ? WHERE id = ?').run('approved', appealId);

    req.adminLog('reset_password', 'user', String(user.id), `重置密码: ${appeal.name} (${appeal.year}届${appeal.class_number}班), 申诉 #${appealId}`);

    res.json({ message: '密码已重置', newPassword });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/admin/verifications — List verification requests
router.get('/verifications', (req, res) => {
  try {
    const requests = db.prepare(`
      SELECT vr.*, u.year, u.class_number, u.name, u.nickname, u.verified_label
      FROM verification_requests vr
      LEFT JOIN users u ON vr.user_id = u.id
      ORDER BY vr.created_at DESC
    `).all();
    res.json({ requests });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/verifications/:id/approve — Approve verification
router.post('/verifications/:id/approve', (req, res) => {
  try {
    const reqId = parseInt(req.params.id);
    const { label } = req.body;
    const request = db.prepare('SELECT * FROM verification_requests WHERE id = ?').get(reqId);
    if (!request) return res.status(404).json({ error: '认证请求不存在' });

    const finalLabel = (label || '').trim() || request.org_name;
    db.prepare('UPDATE users SET verified_label = ?, is_verified = 1 WHERE id = ?').run(finalLabel, request.user_id);
    db.prepare('UPDATE verification_requests SET status = ? WHERE id = ?').run('approved', reqId);

    req.adminLog('approve_verification', 'verification', String(reqId), `通过认证: ${finalLabel} (用户ID: ${request.user_id})`);

    db.prepare(
      'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
    ).run(request.user_id, 'verification_approved', '认证已通过', `你的组织认证已通过！认证标签：${finalLabel}。`);

    res.json({ message: '认证已通过', label: finalLabel });
  } catch (err) {
    console.error('Approve verification error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/verifications/:id/reject — Reject verification
router.post('/verifications/:id/reject', (req, res) => {
  try {
    const reqId = parseInt(req.params.id);
    const request = db.prepare('SELECT * FROM verification_requests WHERE id = ?').get(reqId);
    if (!request) return res.status(404).json({ error: '认证请求不存在' });

    db.prepare('UPDATE verification_requests SET status = ? WHERE id = ?').run('rejected', reqId);

    req.adminLog('reject_verification', 'verification', String(reqId), `拒绝认证: ${request.org_name} (用户ID: ${request.user_id})`);

    const rejectContent = `你的"${request.org_name}"认证申请未通过审核。如有疑问请联系管理员。`;
    db.prepare(
      'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
    ).run(request.user_id, 'verification_rejected', '认证未通过', rejectContent);

    res.json({ message: '认证已拒绝' });
  } catch (err) {
    console.error('Reject verification error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/admin/banned-users — List banned users
router.get('/banned-users', (req, res) => {
  try {
    const users = db.prepare(
      'SELECT id, year, class_number, name, nickname, is_banned, banned_until, ban_reason FROM users WHERE is_banned = 1 ORDER BY banned_until DESC'
    ).all();
    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/users/:id/unban — Unban a user
router.post('/users/:id/unban', (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    db.prepare('UPDATE users SET is_banned = 0, banned_until = NULL, ban_reason = \'\' WHERE id = ?').run(userId);

    req.adminLog('unban_user', 'user', String(userId), `解封用户 ${user.name} (ID: ${userId})`);

    db.prepare(
      'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
    ).run(userId, 'account_unbanned', '账号已解封', '你的账号已被管理员解封，现在可以正常登录使用。');

    res.json({ message: '用户已解封' });
  } catch (err) {
    console.error('Unban error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/ban — Ban an IP (admin and founder)
router.post('/ban', (req, res) => {
  try {
    const { ip, reason, days } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP 地址为必填项' });

    let bannedUntil = null;
    if (days && parseInt(days) > 0) {
      const d = new Date();
      d.setDate(d.getDate() + parseInt(days));
      bannedUntil = d.toISOString().replace('T', ' ').substring(0, 19);
    }

    const existing = db.prepare('SELECT id FROM banned_ips WHERE ip = ?').get(ip.trim());
    if (existing) {
      db.prepare('UPDATE banned_ips SET reason = ?, banned_until = ? WHERE ip = ?')
        .run((reason || '').trim(), bannedUntil, ip.trim());
    } else {
      db.prepare('INSERT INTO banned_ips (ip, reason, banned_until) VALUES (?, ?, ?)')
        .run(ip.trim(), (reason || '').trim(), bannedUntil);
    }

    req.adminLog('ban_ip', 'ip', ip.trim(),
      `封禁IP ${ip.trim()}${days ? ' (' + days + '天)' : '（永久）'}${reason ? ': ' + reason : ''}`);

    res.json({ ip: ip.trim(), banned_until: bannedUntil, message: 'IP 已封禁' });
  } catch (err) {
    console.error('Ban IP error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/ban/:id/unban — Unban an IP
router.post('/ban/:id/unban', (req, res) => {
  try {
    const banId = parseInt(req.params.id);
    const ban = db.prepare('SELECT ip FROM banned_ips WHERE id = ?').get(banId);
    if (!ban) return res.status(404).json({ error: '封禁记录不存在' });

    db.prepare('DELETE FROM banned_ips WHERE id = ?').run(banId);

    req.adminLog('unban_ip', 'ip', ban.ip, `解封IP ${ban.ip}`);

    res.json({ ip: ban.ip, message: 'IP 已解封' });
  } catch (err) {
    console.error('Unban IP error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/admin/banned-ips — List banned IPs
router.get('/banned-ips', (req, res) => {
  try {
    db.prepare("DELETE FROM banned_ips WHERE banned_until IS NOT NULL AND banned_until < datetime('now')").run();
    const ips = db.prepare('SELECT * FROM banned_ips ORDER BY created_at DESC').all();
    res.json({ banned_ips: ips });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/admin/logs — View admin operation logs
router.get('/logs', (req, res) => {
  try {
    const logs = db.prepare(
      'SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 200'
    ).all();
    res.json({ logs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/admin/posts — Get all posts (including hidden)
router.get('/posts', (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params = [];
    let orderClause = "ORDER BY p.pinned DESC, CASE WHEN p.pinned = 1 THEN p.created_at END ASC, p.created_at DESC";

    if (filter === 'hidden') {
      whereClause = 'WHERE p.hidden = 1';
      orderClause = 'ORDER BY p.report_count DESC, p.created_at DESC';
    } else if (filter === 'reported') {
      whereClause = 'WHERE p.report_count > 0';
      orderClause = 'ORDER BY p.report_count DESC, p.created_at DESC';
    }

    // Search query support (numeric → match post id too)
    if (req.query.q) {
      const q = req.query.q.trim();
      const term = `%${q}%`;
      const isNumeric = /^\d+$/.test(q);
      const cond = isNumeric ? '(p.id = ? OR p.content LIKE ?)' : 'p.content LIKE ?';
      if (whereClause) {
        whereClause += ` AND ${cond}`;
      } else {
        whereClause = `WHERE ${cond}`;
      }
      if (isNumeric) { params.push(parseInt(q)); }
      params.push(term);
    }

    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM posts p ${whereClause}`
    ).get(...params);

    const posts = db.prepare(`
      SELECT
        p.*,
        COALESCE(NULLIF(u.nickname, ''), u.name,
          CASE WHEN p.is_anonymous OR p.user_id IS NULL THEN '匿名用户' ELSE '未知用户' END
        ) as display_nickname,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const anonymizedPosts = posts.map(p => {
      if (!req.isFounder && (p.is_anonymous || !p.user_id)) {
        return { ...p, nickname: '匿名用户', name: null, user_id: null, display_nickname: '匿名用户' };
      }
      return { ...p, nickname: p.display_nickname || '未知用户' };
    });

    res.json({
      posts: anonymizedPosts,
      total: countRow.total,
      page,
      totalPages: Math.ceil(countRow.total / limit)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/admin/manage-users — Browse/manage users
router.get('/manage-users', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params = [];
    if (q) {
      whereClause = 'WHERE u.name LIKE ? OR u.nickname LIKE ?';
      params.push(`%${q}%`, `%${q}%`);
    }

    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM users u ${whereClause}`
    ).get(...params);

    const users = db.prepare(`
      SELECT u.id, u.year, u.class_number, u.name, u.nickname, u.is_verified,
             u.verified_label, u.role, u.is_banned, u.banned_until, u.ban_reason,
             u.created_at,
             (SELECT COUNT(*) FROM posts WHERE user_id = u.id) as post_count
      FROM users u
      ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ users, total: countRow.total, page, totalPages: Math.ceil(countRow.total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/users/:id/set-role — Set user role (founder only)
router.post('/users/:id/set-role', (req, res) => {
  if (!req.isFounder) return res.status(403).json({ error: '仅超级管理员可执行此操作' });
  try {
    const userId = parseInt(req.params.id);
    const { role } = req.body; // 'user', 'admin', 'founder'
    if (!['user', 'admin', 'founder'].includes(role)) {
      return res.status(400).json({ error: '无效的角色' });
    }

    const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);

    req.adminLog('set_role', 'user', String(userId), `设置用户 ${user.name} 角色为 ${role}`);
    res.json({ message: '角色已更新' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/users/:id/ban — Ban a user (admin and founder)
router.post('/users/:id/ban', (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { reason, days } = req.body;

    const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    let bannedUntil = null;
    if (days && days > 0) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      bannedUntil = d.toISOString().replace('T', ' ').substring(0, 19);
    }

    db.prepare('UPDATE users SET is_banned = 1, banned_until = ?, ban_reason = ? WHERE id = ?')
      .run(bannedUntil, (reason || '').trim(), userId);

    req.adminLog('ban_user', 'user', String(userId), `封禁用户 ${user.name}${days ? ' (' + days + '天)' : '（永久）'}${reason ? ': ' + reason : ''}`);

    db.prepare(
      'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
    ).run(userId, 'account_banned', '账号已被封禁', `你的账号已被管理员封禁${days ? ' ' + days + '天' : ''}${reason ? '，原因：' + reason : ''}`);

    res.json({ message: '用户已封禁' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ===== Boards Management =====

// GET /api/admin/boards — List all boards (admin view)
router.get('/boards', (req, res) => {
  try {
    const boards = db.prepare('SELECT * FROM boards ORDER BY created_at').all();
    res.json({ boards });
  } catch (err) {
    console.error('Admin boards list error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/admin/boards — Create a board
router.post('/boards', (req, res) => {
  try {
    const { name, icon, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '板块名称不能为空' });

    // Check duplicate name
    const existing = db.prepare('SELECT id FROM boards WHERE name = ?').get(name.trim());
    if (existing) return res.status(409).json({ error: '板块名称已存在' });

    const result = db.prepare(
      'INSERT INTO boards (name, icon, description) VALUES (?, ?, ?)'
    ).run(name.trim(), (icon || '📌').trim(), (description || '').trim());

    req.adminLog('create_board', 'board', String(result.lastInsertRowid), `创建板块: ${name.trim()}`);

    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ board });
  } catch (err) {
    console.error('Create board error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// DELETE /api/admin/boards/:id — Delete a board (posts fall back to NULL board_id)
router.delete('/boards/:id', (req, res) => {
  try {
    const boardId = parseInt(req.params.id);
    const board = db.prepare('SELECT id, name FROM boards WHERE id = ?').get(boardId);
    if (!board) return res.status(404).json({ error: '板块不存在' });

    // Set all posts in this board back to NULL board_id
    db.prepare('UPDATE posts SET board_id = NULL WHERE board_id = ?').run(boardId);

    db.prepare('DELETE FROM boards WHERE id = ?').run(boardId);

    req.adminLog('delete_board', 'board', String(boardId), `删除板块: ${board.name}，帖子已回落首页`);

    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete board error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
