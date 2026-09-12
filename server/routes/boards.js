const express = require('express');
const router = express.Router();
const db = require('../db');
const points = require('../points');
const { auth, optionalAuth } = require('./auth');

// GET /api/boards — List all boards (no auth required)
router.get('/', (req, res) => {
  try {
    const boards = db.prepare('SELECT id, name, icon, description FROM boards ORDER BY created_at').all();
    res.json({ boards });
  } catch (err) {
    console.error('Boards list error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/boards/:id — Board detail
router.get('/:id', (req, res) => {
  try {
    const board = db.prepare('SELECT id, name, icon, description FROM boards WHERE id = ?').get(parseInt(req.params.id));
    if (!board) return res.status(404).json({ error: '板块不存在' });
    res.json({ board });
  } catch (err) {
    console.error('Board detail error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/boards/:id/posts — Posts in a board (public, optional auth for like status)
router.get('/:id/posts', optionalAuth, (req, res) => {
  try {
    const boardId = parseInt(req.params.id);
    const board = db.prepare('SELECT id FROM boards WHERE id = ?').get(boardId);
    if (!board) return res.status(404).json({ error: '板块不存在' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE p.hidden = 0 AND p.board_id = ?';
    const params = [boardId];

    // External users filter
    if (req.user && req.user.is_external) {
      whereClause += ' AND (p.external_hidden = 0 OR p.external_hidden IS NULL)';
    }

    // Onboarding welcome post filter
    if (req.user) {
      const u = db.prepare('SELECT role, created_at FROM users WHERE id = ?').get(req.user.userId);
      const isFounder = u && u.role === 'founder';
      if (!isFounder && u && u.created_at) {
        const cutoff = db.prepare("SELECT datetime('now', '-12 hours') AS t").get().t;
        if (u.created_at < cutoff) {
          whereClause += ' AND (p.onboarding = 0 OR p.onboarding IS NULL)';
        }
      }
    }

    // Count
    const countRow = db.prepare(`SELECT COUNT(*) as total FROM posts p ${whereClause}`).get(...params);
    const total = countRow.total;

    // Fetch posts
    const posts = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id AND hidden = 0) as comment_count
      FROM posts p
      ${whereClause}
      ORDER BY p.pinned DESC, CASE WHEN p.pinned = 1 THEN p.created_at END ASC, p.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // Enrich posts (mirror main posts route logic)
    const enrichedPosts = posts.map(post => {
      if (!post.is_anonymous && post.user_id) {
        post.author = points.authorMeta(db.prepare(
          'SELECT id, year, class_number, name, nickname, verified_label, avatar_type, avatar_url, level, nickname_color, points FROM users WHERE id = ?'
        ).get(post.user_id));
      }
      if (req.user) {
        const liked = db.prepare('SELECT id FROM likes WHERE post_id = ? AND user_id = ?').get(post.id, req.user.userId);
        post.user_liked = !!liked;
      }
      // Poll
      const poll = db.prepare('SELECT * FROM polls WHERE post_id = ?').get(post.id);
      if (poll) {
        poll.options = db.prepare('SELECT * FROM poll_options WHERE poll_id = ?').all(poll.id);
        const totalVotes = poll.options.reduce((sum, o) => sum + (o.vote_count || 0), 0);
        poll.total_votes = totalVotes;
        if (req.user) {
          const myVote = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(poll.id, req.user.userId);
          poll.my_vote = myVote ? myVote.option_id : null;
        }
        post.poll = poll;
      }
      // Board info
      post.board = { id: board.id, name: board.name, icon: board.icon };
      return post;
    });

    res.json({ posts: enrichedPosts, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Board posts error:', err);
    res.status(500).json({ error: '加载失败' });
  }
});

module.exports = router;
