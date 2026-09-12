const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET, getTokenFromReq } = require('../auth-helper');

// Auth middleware: extracts user if token is valid (optional auth for POST)
function optionalAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch {
      // Token invalid, continue without user
    }
  }
  next();
}

// Auth middleware: founder-only for GET/DELETE
function founderAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(decoded.userId);
    if (!user || user.role !== 'founder') {
      return res.status(403).json({ error: '权限不足，仅站长可访问留言' });
    }
    req.adminName = user.name;
    next();
  } catch {
    return res.status(401).json({ error: '令牌无效或已过期' });
  }
}

// Helper: get client IP
function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         '127.0.0.1';
}

// POST /api/messages — Submit a message (public, optional auth)
router.post('/', optionalAuth, (req, res) => {
  try {
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: '内容不能为空' });
    }

    if (content.trim().length > 500) {
      return res.status(400).json({ error: '留言内容不能超过 500 字' });
    }

    const ip = getIp(req);
    const userId = req.user ? req.user.userId : null;

    const result = db.prepare(
      'INSERT INTO messages (user_id, content, ip) VALUES (?, ?, ?)'
    ).run(userId, content.trim(), ip);

    res.status(201).json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Message submit error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/messages — List all messages (founder only)
router.get('/', founderAuth, (req, res) => {
  try {
    const messages = db.prepare(`
      SELECT m.*, u.name, u.nickname
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      ORDER BY m.created_at DESC
      LIMIT 200
    `).all();

    const enriched = messages.map(m => ({
      id: m.id,
      content: m.content,
      ip: m.ip,
      is_read: m.is_read,
      created_at: m.created_at,
      reply: m.reply || '',
      replied_at: m.replied_at,
      user_id: m.user_id,
      sender: m.user_id
        ? (m.nickname || m.name || '未知用户')
        : '游客'
    }));

    res.json({ messages: enriched });
  } catch (err) {
    console.error('Messages list error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// DELETE /api/messages/:id — Delete a message (founder only)
router.delete('/:id', founderAuth, (req, res) => {
  try {
    const msgId = parseInt(req.params.id);
    const msg = db.prepare('SELECT id FROM messages WHERE id = ?').get(msgId);
    if (!msg) {
      return res.status(404).json({ error: '留言不存在' });
    }

    db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);

    res.json({ success: true, message: '留言已删除' });
  } catch (err) {
    console.error('Message delete error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/messages/:id/reply — Reply to a message (founder only)
router.post('/:id/reply', founderAuth, (req, res) => {
  try {
    const msgId = parseInt(req.params.id);
    const { reply } = req.body;

    if (!reply || !reply.trim()) {
      return res.status(400).json({ error: '回复内容不能为空' });
    }
    if (reply.trim().length > 1000) {
      return res.status(400).json({ error: '回复内容不能超过 1000 字' });
    }

    const msg = db.prepare('SELECT id, user_id FROM messages WHERE id = ?').get(msgId);
    if (!msg) {
      return res.status(404).json({ error: '留言不存在' });
    }

    db.prepare("UPDATE messages SET reply = ?, replied_at = datetime('now'), is_read = 1 WHERE id = ?")
      .run(reply.trim(), msgId);

    // Notify the message author if they are a registered user
    if (msg.user_id) {
      db.prepare('INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)').run(
        msg.user_id, 'system', '📩 站长回复了你的留言',
        reply.trim()
      );
    }

    res.json({ success: true, reply: reply.trim() });
  } catch (err) {
    console.error('Message reply error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/messages/my — List current user's own messages with replies (auth)
router.get('/my', (req, res) => {
  const token = getTokenFromReq(req);
  if (!token) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const messages = db.prepare(`
      SELECT id, content, reply, replied_at, created_at
      FROM messages
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(decoded.userId);
    res.json({ messages });
  } catch {
    return res.status(401).json({ error: '令牌无效或已过期' });
  }
});

module.exports = router;
