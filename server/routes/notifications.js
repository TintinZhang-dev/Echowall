const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth } = require('./auth');

// GET /api/notifications — Get current user's notifications
router.get('/', auth, (req, res) => {
  try {
    const notifications = db.prepare(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
    ).all(req.user.userId);

    const unreadRow = db.prepare(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0'
    ).get(req.user.userId);

    res.json({ notifications, unreadCount: unreadRow.count });
  } catch (err) {
    console.error('Notifications error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/notifications/:id/read — Mark single notification as read
router.post('/:id/read', auth, (req, res) => {
  try {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
      .run(parseInt(req.params.id), req.user.userId);
    res.json({ read: true });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/notifications/read-all — Mark all as read
router.post('/read-all', auth, (req, res) => {
  try {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0')
      .run(req.user.userId);
    res.json({ read: true });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
