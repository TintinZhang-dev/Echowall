// [2026-08-09] Direct Messages — user-to-user private messaging
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('./auth');

// GET /api/dm/conversations — list all conversations for current user
router.get('/conversations', auth, (req, res) => {
  try {
    const userId = req.user.userId;

    // Find all distinct conversation partners and their last message
    // Strategy: for each pair (user, other), find the latest message
    const rows = db.prepare(`
      SELECT
        CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END AS partner_id,
        m.content AS last_message,
        m.created_at AS last_message_at,
        m.sender_id,
        m.receiver_id,
        (SELECT COUNT(*) FROM dm_messages d
         WHERE d.sender_id = CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END
           AND d.receiver_id = ? AND d.is_read = 0) AS unread_count
      FROM dm_messages m
      WHERE m.id IN (
        SELECT MAX(id) FROM dm_messages
        WHERE sender_id = ? OR receiver_id = ?
        GROUP BY
          CASE WHEN sender_id < receiver_id THEN sender_id || '-' || receiver_id
               ELSE receiver_id || '-' || sender_id END
      )
      ORDER BY m.created_at DESC
    `).all(userId, userId, userId, userId, userId);

    // Enrich with partner user info
    const conversations = rows.map(row => {
      const partner = db.prepare(
        'SELECT id, name, nickname, avatar_type, avatar_url, is_external, school, is_banned FROM users WHERE id = ?'
      ).get(row.partner_id);
      if (!partner) return null;
      return {
        user: partner,
        last_message: row.last_message,
        last_message_at: row.last_message_at,
        unread_count: row.unread_count || 0
      };
    }).filter(Boolean);

    res.json({ conversations });
  } catch (err) {
    console.error('[dm] conversations error:', err);
    res.status(500).json({ error: '加载会话失败' });
  }
});

// GET /api/dm/:userId/messages — chat history with a specific user
router.get('/:userId/messages', auth, (req, res) => {
  try {
    const currentUserId = req.user.userId;
    const partnerId = parseInt(req.params.userId);

    if (isNaN(partnerId)) {
      return res.status(400).json({ error: '无效的用户 ID' });
    }
    if (partnerId === currentUserId) {
      return res.status(400).json({ error: '不能给自己发消息' });
    }

    // Verify partner exists
    const partner = db.prepare('SELECT id, is_banned FROM users WHERE id = ?').get(partnerId);
    if (!partner) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // Get last 50 messages between these two users
    const messages = db.prepare(`
      SELECT id, sender_id, content, is_read, created_at
      FROM dm_messages
      WHERE (sender_id = ? AND receiver_id = ?)
         OR (sender_id = ? AND receiver_id = ?)
      ORDER BY id DESC
      LIMIT 50
    `).all(currentUserId, partnerId, partnerId, currentUserId);

    // Mark messages from partner to me as read
    db.prepare(`
      UPDATE dm_messages SET is_read = 1
      WHERE sender_id = ? AND receiver_id = ? AND is_read = 0
    `).run(partnerId, currentUserId);

    res.json({ messages: messages.reverse() });
  } catch (err) {
    console.error('[dm] messages error:', err);
    res.status(500).json({ error: '加载聊天记录失败' });
  }
});

// POST /api/dm/:userId — send a message
router.post('/:userId', auth, (req, res) => {
  try {
    const senderId = req.user.userId;
    const receiverId = parseInt(req.params.userId);
    const { content } = req.body;

    // Validate receiver ID
    if (isNaN(receiverId)) {
      return res.status(400).json({ error: '无效的用户 ID' });
    }
    if (receiverId === senderId) {
      return res.status(400).json({ error: '不能给自己发消息' });
    }

    // Validate content
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: '消息内容不能为空' });
    }
    if (String(content).length > 2000) {
      return res.status(400).json({ error: '消息内容不能超过 2000 字' });
    }

    // Check sender is not banned
    const sender = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(senderId);
    if (sender && sender.is_banned) {
      return res.status(403).json({ error: '您的账号已被封禁，无法发送私信' });
    }

    // Check receiver exists and is not banned
    const receiver = db.prepare('SELECT id, is_banned FROM users WHERE id = ?').get(receiverId);
    if (!receiver) {
      return res.status(404).json({ error: '用户不存在' });
    }
    if (receiver.is_banned) {
      return res.status(403).json({ error: '对方账号已被封禁，无法发送私信' });
    }

    const result = db.prepare(
      'INSERT INTO dm_messages (sender_id, receiver_id, content) VALUES (?, ?, ?)'
    ).run(senderId, receiverId, String(content).trim());

    const newMsg = db.prepare('SELECT id, sender_id, content, is_read, created_at FROM dm_messages WHERE id = ?').get(result.lastInsertRowid);

    res.json({ message: newMsg });
  } catch (err) {
    console.error('[dm] send error:', err);
    res.status(500).json({ error: '发送失败' });
  }
});

module.exports = router;
