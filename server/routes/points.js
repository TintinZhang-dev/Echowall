const express = require('express');
const router = express.Router();
const db = require('../db');
const points = require('../points');
const { auth } = require('./auth');

// GET /api/points — 当前积分概览 + 等级进度 + 最近明细 + 置顶特权余额
router.get('/', auth, (req, res) => {
  try {
    const uid = req.user.userId;
    const overview = points.overview(uid);
    if (!overview) return res.status(404).json({ error: '用户不存在' });

    // 置顶特权剩余次数
    const u = db.prepare('SELECT level, daily_pin_used, daily_pin_date, weekly_pin_used, weekly_pin_week FROM users WHERE id = ?').get(uid);
    const quota = points.pinQuotaFor(u.level || 1);
    let pin = null;
    if (quota) {
      if (quota.period === 'daily') {
        const used = (u.daily_pin_date === points.todayUTC()) ? (u.daily_pin_used || 0) : 0;
        pin = { ...quota, used, remaining: Math.max(0, quota.max - used) };
      } else {
        const used = (u.weekly_pin_week === points.weekStr()) ? (u.weekly_pin_used || 0) : 0;
        pin = { ...quota, used, remaining: Math.max(0, quota.max - used) };
      }
    }

    res.json({ ...overview, pin });
  } catch (err) {
    console.error('Points error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
