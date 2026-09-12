const express = require('express');
const router = express.Router();
const db = require('../db');
const points = require('../points');
const { optionalAuth } = require('./auth');

// GET /api/search/posts?q=keyword&page=1
router.get('/posts', optionalAuth, (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;

    if (!q) return res.json({ posts: [], total: 0, page: 1, totalPages: 0 });

    const searchTerm = `%${q}%`;
    // External users cannot see external_hidden posts
    const extFilter = (req.user && req.user.is_external) ? ' AND (external_hidden = 0 OR external_hidden IS NULL)' : '';
    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM posts WHERE hidden = 0 AND content LIKE ?${extFilter}`
    ).get(searchTerm);
    const total = countRow.total;

    const posts = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
      FROM posts p
      WHERE p.hidden = 0 AND p.content LIKE ?${extFilter}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `).all(searchTerm, limit, offset);

    // Enrich with author info and like status
    const enriched = posts.map(post => {
      if (!post.is_anonymous && post.user_id) {
        const author = db.prepare(
          'SELECT id, year, class_number, name, nickname, verified_label, avatar_type, avatar_url, level, nickname_color, points FROM users WHERE id = ?'
        ).get(post.user_id);
        post.author = points.authorMeta(author);
      } else {
        post.author = null;
      }
      if (req.user) {
        const liked = db.prepare('SELECT id FROM likes WHERE post_id = ? AND user_id = ?').get(post.id, req.user.userId);
        post.user_liked = !!liked;
      }
      return post;
    });

    res.json({ posts: enriched, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '搜索失败' });
  }
});

// GET /api/search/users?q=keyword
router.get('/users', optionalAuth, (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ users: [] });

    const searchTerm = `%${q}%`;
    const users = db.prepare(`
      SELECT id, year, class_number, name, nickname, verified_label, is_verified, follower_count, following_count, avatar_type, avatar_url, level, nickname_color, points
      FROM users
      WHERE name LIKE ? OR nickname LIKE ?
      LIMIT 20
    `).all(searchTerm, searchTerm);

    res.json({ users: users.map(u => points.authorMeta(u)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '搜索失败' });
  }
});

module.exports = router;
