const express = require('express');
const router = express.Router();
const db = require('../db');
const points = require('../points');
const { auth, optionalAuth } = require('./auth');

// POST /api/follow/:id — Toggle follow
router.post('/:id', auth, (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === req.user.userId) {
      return res.status(400).json({ error: '不能关注自己' });
    }

    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: '用户不存在' });

    const existing = db.prepare(
      'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?'
    ).get(req.user.userId, targetId);

    if (existing) {
      db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.user.userId, targetId);
      db.prepare('UPDATE users SET following_count = MAX(0, following_count - 1) WHERE id = ?').run(req.user.userId);
      db.prepare('UPDATE users SET follower_count = MAX(0, follower_count - 1) WHERE id = ?').run(targetId);
      res.json({ following: false });
    } else {
      db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)').run(req.user.userId, targetId);
      db.prepare('UPDATE users SET following_count = following_count + 1 WHERE id = ?').run(req.user.userId);
      db.prepare('UPDATE users SET follower_count = follower_count + 1 WHERE id = ?').run(targetId);

      // Notify the followed user
      const follower = db.prepare('SELECT nickname, name FROM users WHERE id = ?').get(req.user.userId);
      const followerName = (follower && (follower.nickname || follower.name)) || '有人';
      db.prepare(
        'INSERT INTO notifications (user_id, type, title, content) VALUES (?, ?, ?, ?)'
      ).run(targetId, 'new_follower', '新的关注者', `${followerName} 关注了你`);

      // [2026-08-16] 被关注 +2（每日上限 6，10 秒去重，target_id = 关注者 id）
      points.award(targetId, 2, 'followed', req.user.userId, 'target');

      res.json({ following: true });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/follow/status/:id — Check if following
router.get('/status/:id', auth, (req, res) => {
  const existing = db.prepare(
    'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?'
  ).get(req.user.userId, parseInt(req.params.id));
  res.json({ following: !!existing });
});

// GET /api/follow/feed — Get posts from followed users
router.get('/feed', auth, (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;

    const countRow = db.prepare(`
      SELECT COUNT(*) as total FROM posts p
      WHERE p.hidden = 0 AND p.is_anonymous = 0 AND p.user_id IN (
        SELECT following_id FROM follows WHERE follower_id = ?
      )${req.user.is_external ? ' AND (p.external_hidden = 0 OR p.external_hidden IS NULL)' : ''}
    `).get(req.user.userId);
    const total = countRow.total;

    const posts = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
      FROM posts p
      WHERE p.hidden = 0 AND p.is_anonymous = 0 AND p.user_id IN (
        SELECT following_id FROM follows WHERE follower_id = ?
      )${req.user.is_external ? ' AND (p.external_hidden = 0 OR p.external_hidden IS NULL)' : ''}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.user.userId, limit, offset);

    // Enrich with author info
    const enriched = posts.map(post => {
      if (!post.is_anonymous && post.user_id) {
        post.author = points.authorMeta(db.prepare(
          'SELECT id, year, class_number, name, nickname, verified_label, avatar_type, avatar_url, level, nickname_color, points FROM users WHERE id = ?'
        ).get(post.user_id));
      }
      if (req.user) {
        const liked = db.prepare('SELECT id FROM likes WHERE post_id = ? AND user_id = ?').get(post.id, req.user.userId);
        post.user_liked = !!liked;
      }
      // [2026-08-07] Repost refactor: enrich repost with full original post data including poll
      if (post.repost_of) {
        const originalPost = db.prepare(`
          SELECT p.*, u.nickname, u.name FROM posts p
          LEFT JOIN users u ON p.user_id = u.id
          WHERE p.id = ?
        `).get(post.repost_of);
        if (originalPost) {
          post.repost_content = originalPost.content;
          post.repost_media_url = originalPost.media_url;
          post.repost_media_urls = originalPost.media_urls;
          post.repost_author = originalPost.is_anonymous
            ? '匿名'
            : (originalPost.nickname || originalPost.name || '用户');
          post.repost_original = {
            id: originalPost.id,
            content: originalPost.content,
            media_url: originalPost.media_url,
            media_urls: originalPost.media_urls,
            docx_url: originalPost.docx_url,
            docx_name: originalPost.docx_name,
            is_anonymous: originalPost.is_anonymous,
            user_id: originalPost.user_id,
            category: originalPost.category
          };
          // Attach original post's poll data
          const repostPoll = db.prepare('SELECT * FROM polls WHERE post_id = ?').get(originalPost.id);
          if (repostPoll) {
            repostPoll.options = db.prepare('SELECT * FROM poll_options WHERE poll_id = ?').all(repostPoll.id);
            const totalVotes = repostPoll.options.reduce((sum, o) => sum + (o.vote_count || 0), 0);
            repostPoll.total_votes = totalVotes;
            if (req.user) {
              const myVote = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(repostPoll.id, req.user.userId);
              repostPoll.my_vote = myVote ? myVote.option_id : null;
            }
            post.repost_poll = repostPoll;
          }
          // Get original post's like/comment counts
          const origCounts = db.prepare(`
            SELECT
              (SELECT COUNT(*) FROM likes WHERE post_id = ?) as like_count,
              (SELECT COUNT(*) FROM comments WHERE post_id = ? AND hidden = 0) as comment_count
          `).get(originalPost.id, originalPost.id);
          post.repost_like_count = origCounts.like_count;
          post.repost_comment_count = origCounts.comment_count;
          // Check if current user liked the original post
          if (req.user) {
            const origLiked = db.prepare('SELECT id FROM likes WHERE post_id = ? AND user_id = ?').get(originalPost.id, req.user.userId);
            post.repost_user_liked = !!origLiked;
          }
        }
      }
      // [2026-08-03] 任务5: attach poll data
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
      return post;
    });

    res.json({ posts: enriched, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '加载失败' });
  }
});

// GET /api/follow/following — Get list of users I follow
router.get('/following', auth, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.nickname, u.year, u.class_number, u.verified_label, u.avatar_type, u.avatar_url
    FROM follows f JOIN users u ON f.following_id = u.id
    WHERE f.follower_id = ?
    ORDER BY f.created_at DESC
  `).all(req.user.userId);
  res.json({ users });
});

module.exports = router;
