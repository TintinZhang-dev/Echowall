const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const points = require('../points');
const { auth, optionalAuth } = require('./auth');

// GET /api/user/:id/posts — Get posts by a specific user (public)
router.get('/:id/posts', optionalAuth, (req, res) => {
  const userId = parseInt(req.params.id);
  if (!userId) return res.status(400).json({ error: '无效的用户ID' });

  // [2026-08-04] 任务1: 匿名帖仅帖主本人可见，其他人过滤掉
  const isOwner = req.user && req.user.userId === userId;
  const anonFilter = isOwner ? '' : ' AND (p.is_anonymous = 0 OR p.is_anonymous IS NULL)';

  const posts = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
    FROM posts p
    WHERE p.user_id = ? AND p.hidden = 0${anonFilter}
    ORDER BY p.created_at DESC LIMIT 50
  `).all(userId);

  const enriched = posts.map(post => {
    if (!post.is_anonymous && post.user_id) {
      const author = db.prepare(
        'SELECT id, year, class_number, name, nickname, verified_label, avatar_type, avatar_url, level, nickname_color, points FROM users WHERE id = ?'
      ).get(post.user_id);
      post.author = points.authorMeta(author);
    }
    if (req.user) {
      const liked = db.prepare('SELECT id FROM likes WHERE post_id = ? AND user_id = ?').get(post.id, req.user.userId);
      post.user_liked = !!liked;
    }
    // [2026-08-07] Repost refactor: enrich repost with full original data
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
        post.repost_original = { id: originalPost.id, content: originalPost.content, media_url: originalPost.media_url, media_urls: originalPost.media_urls, docx_url: originalPost.docx_url, docx_name: originalPost.docx_name, is_anonymous: originalPost.is_anonymous };
        const repostPoll = db.prepare('SELECT * FROM polls WHERE post_id = ?').get(originalPost.id);
        if (repostPoll) {
          repostPoll.options = db.prepare('SELECT * FROM poll_options WHERE poll_id = ?').all(repostPoll.id);
          repostPoll.total_votes = repostPoll.options.reduce((sum, o) => sum + (o.vote_count || 0), 0);
          if (req.user) {
            const myVote = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(repostPoll.id, req.user.userId);
            repostPoll.my_vote = myVote ? myVote.option_id : null;
          }
          post.repost_poll = repostPoll;
        }
        const origCounts = db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM likes WHERE post_id = ?) as like_count,
            (SELECT COUNT(*) FROM comments WHERE post_id = ? AND hidden = 0) as comment_count
        `).get(originalPost.id, originalPost.id);
        post.repost_like_count = origCounts.like_count;
        post.repost_comment_count = origCounts.comment_count;
        if (req.user) {
          const origLiked = db.prepare('SELECT id FROM likes WHERE post_id = ? AND user_id = ?').get(originalPost.id, req.user.userId);
          post.repost_user_liked = !!origLiked;
        }
      }
    }
    return post;
  });

  const user = db.prepare(
    'SELECT id, year, class_number, name, nickname, bio, verified_label, is_verified, role, follower_count, following_count, is_external, school, profile_public, avatar_type, avatar_url, points, level, nickname_color, font_size, streak_days FROM users WHERE id = ?'
  ).get(userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // [2026-08-03] 任务4: check profile privacy
  if (user.profile_public === 0) {
    let isSelf = false;
    let isStaff = false;
    if (req.user) {
      isSelf = req.user.userId === userId;
      if (!isSelf) {
        const reqUser = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.userId);
        isStaff = reqUser && (reqUser.role === 'founder' || reqUser.role === 'admin');
      }
    }
    if (!isSelf && !isStaff) {
      return res.json({ user: { id: user.id, name: user.name, nickname: user.nickname, profile_public: 0 }, posts: [], following: false, profile_hidden: true });
    }
  }

  // Check follow status if logged in
  let following = false;
  if (req.user) {
    const f = db.prepare('SELECT id FROM follows WHERE follower_id = ? AND following_id = ?').get(req.user.userId, userId);
    following = !!f;
  }

  // [2026-08-16] 等级进度条信息
  const profileUser = points.authorMeta(user);
  const next = points.getNextLevelInfo(profileUser.level, profileUser.points);
  const curInfo = points.getLevelInfo(profileUser.level);
  profileUser.next_level = next;
  profileUser.progress_pct = next
    ? Math.min(100, Math.round(((profileUser.points - curInfo.points) / (next.points - curInfo.points)) * 100))
    : 100;

  res.json({ user: profileUser, posts: enriched, following });
});

// All routes below require auth
router.use(auth);

// PUT /api/user/profile — Update nickname, bio, year, class_number
router.put('/profile', (req, res) => {
  try {
    const { nickname, bio, year, class_number, nickname_color, font_size } = req.body;
    const userId = req.user.userId;

    // Get current user data
    const currentUser = db.prepare('SELECT year, class_number, name, level, points FROM users WHERE id = ?').get(userId);
    if (!currentUser) return res.status(404).json({ error: '用户不存在' });

    // Update nickname if provided
    if (nickname !== undefined) {
      db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(
        (nickname || '').trim().substring(0, 50), userId
      );
    }

    // Update bio if provided
    if (bio !== undefined) {
      db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(
        (bio || '').trim().substring(0, 200), userId
      );
    }

    // [2026-08-16] 昵称颜色（Lv.2 解锁）——可选色与等级颜色一致
    if (nickname_color !== undefined) {
      const ALLOWED_COLORS = ['#22c55e', '#84cc16', '#ec4899', '#3b82f6', '#8b5cf6', '#f59e0b'];
      const color = String(nickname_color || '').trim().toLowerCase();
      if (color !== '') {
        if (!ALLOWED_COLORS.includes(color)) {
          return res.status(400).json({ error: '无效的昵称颜色' });
        }
        if ((currentUser.level || 1) < 2) {
          return res.status(403).json({ error: '彩色昵称 Lv.2 解锁' });
        }
      }
      db.prepare('UPDATE users SET nickname_color = ? WHERE id = ?').run(color, userId);
    }

    // [2026-08-16] 帖子字体大小（Lv.3 解锁）
    if (font_size !== undefined) {
      const size = String(font_size || 'medium').trim();
      if (!['small', 'medium', 'large'].includes(size)) {
        return res.status(400).json({ error: '无效的字体大小' });
      }
      if (size !== 'medium' && (currentUser.level || 1) < 3) {
        return res.status(403).json({ error: '字体大小设置 Lv.3 解锁' });
      }
      db.prepare('UPDATE users SET font_size = ? WHERE id = ?').run(size, userId);
    }

    // Update year/class_number if provided
    const newYear = year !== undefined ? parseInt(year) : null;
    const newClass = class_number !== undefined ? parseInt(class_number) : null;

    if (newYear !== null || newClass !== null) {
      const y = newYear !== null ? newYear : currentUser.year;
      const c = newClass !== null ? newClass : currentUser.class_number;

      // Validate
      if (newYear !== null && (isNaN(y) || y < 1 || y > 99)) {
        return res.status(400).json({ error: '年级必须是 1-99 的数字' });
      }
      if (newClass !== null && (isNaN(c) || c < 1)) {
        return res.status(400).json({ error: '班级必须是正整数' });
      }

      // Check uniqueness: year + class_number + name must be unique
      const conflict = db.prepare(
        'SELECT id FROM users WHERE year = ? AND class_number = ? AND name = ? AND id != ?'
      ).get(y, c, currentUser.name, userId);
      if (conflict) {
        return res.status(409).json({ error: '该班级已有同名用户，请联系管理员' });
      }

      // Log the change
      const oldClass = `${currentUser.year}届${currentUser.class_number || '?'}班`;
      const newClassStr = `${y}届${c}班`;
      db.prepare(
        'INSERT INTO admin_logs (action, target_type, target_id, detail) VALUES (?, ?, ?, ?)'
      ).run('user_change_class', 'user', String(userId),
        `[用户自助] 班级从 ${oldClass} 修改为 ${newClassStr}`);

      // Apply changes
      db.prepare('UPDATE users SET year = ?, class_number = ? WHERE id = ?').run(y, c, userId);
    }

    const user = db.prepare(
      'SELECT id, year, class_number, name, nickname, is_verified, is_admin, role, avatar_type, avatar_url, created_at, profile_public, points, level, nickname_color, font_size, streak_days FROM users WHERE id = ?'
    ).get(userId);
    res.json({ user: points.authorMeta(user) });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// [2026-08-03] 任务4: POST /api/user/privacy — Toggle profile public/private
router.post('/privacy', (req, res) => {
  try {
    const { profile_public } = req.body;
    const val = profile_public ? 1 : 0;
    db.prepare('UPDATE users SET profile_public = ? WHERE id = ?').run(val, req.user.userId);
    res.json({ profile_public: val });
  } catch (err) {
    console.error('Privacy update error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// PUT /api/user/class — Set class number
router.put('/class', (req, res) => {
  try {
    const { class_number } = req.body;
    const classNum = parseInt(class_number);
    if (isNaN(classNum) || classNum < 1 || classNum > 99) {
      return res.status(400).json({ error: '班级必须是 1-99 的数字' });
    }
    db.prepare('UPDATE users SET class_number = ? WHERE id = ?').run(classNum, req.user.userId);
    res.json({ class_number: classNum });
  } catch (err) {
    console.error('Set class error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/user/change-password — Change password
router.post('/change-password', (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '请填写旧密码和新密码' });
    }
    if (newPassword.length < 4) {
      return res.status(400).json({ error: '新密码至少需要4个字符' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
      return res.status(401).json({ error: '旧密码错误' });
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.userId);

    res.json({ message: '密码已修改' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/user/posts — Get current user's own posts
router.get('/posts', (req, res) => {
  try {
    const posts = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
      FROM posts p
      WHERE p.user_id = ?
      ORDER BY p.created_at DESC
      LIMIT 100
    `).all(req.user.userId);

    // Attach author info
    const { getAuthorInfo } = require('./posts');
    // Can't easily import the helper, just fetch directly
    const user = db.prepare(
      'SELECT id, year, class_number, name, nickname, avatar_type, avatar_url FROM users WHERE id = ?'
    ).get(req.user.userId);

    const enrichedPosts = posts.map(p => {
      if (p.is_anonymous) {
        p.author = null;
      } else {
        p.author = user;
      }
      // [2026-08-07] Repost refactor: enrich repost with full original data
      if (p.repost_of) {
        const originalPost = db.prepare(`
          SELECT po.*, u2.nickname, u2.name FROM posts po
          LEFT JOIN users u2 ON po.user_id = u2.id
          WHERE po.id = ?
        `).get(p.repost_of);
        if (originalPost) {
          p.repost_content = originalPost.content;
          p.repost_media_url = originalPost.media_url;
          p.repost_media_urls = originalPost.media_urls;
          p.repost_author = originalPost.is_anonymous
            ? '匿名'
            : (originalPost.nickname || originalPost.name || '用户');
          p.repost_original = { id: originalPost.id, content: originalPost.content, media_url: originalPost.media_url, media_urls: originalPost.media_urls, docx_url: originalPost.docx_url, docx_name: originalPost.docx_name, is_anonymous: originalPost.is_anonymous };
          const repostPoll = db.prepare('SELECT * FROM polls WHERE post_id = ?').get(originalPost.id);
          if (repostPoll) {
            repostPoll.options = db.prepare('SELECT * FROM poll_options WHERE poll_id = ?').all(repostPoll.id);
            repostPoll.total_votes = repostPoll.options.reduce((sum, o) => sum + (o.vote_count || 0), 0);
            p.repost_poll = repostPoll;
          }
          const origCounts = db.prepare(`
            SELECT
              (SELECT COUNT(*) FROM likes WHERE post_id = ?) as like_count,
              (SELECT COUNT(*) FROM comments WHERE post_id = ? AND hidden = 0) as comment_count
          `).get(originalPost.id, originalPost.id);
          p.repost_like_count = origCounts.like_count;
          p.repost_comment_count = origCounts.comment_count;
        }
      }
      return p;
    });

    res.json({ posts: enrichedPosts });
  } catch (err) {
    console.error('User posts error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/user/status — Check if user is suspended (no class after Sep 1)
router.get('/status', auth, (req, res) => {
  const user = db.prepare('SELECT class_number FROM users WHERE id = ?').get(req.user.userId);
  const noClass = !user || !user.class_number || user.class_number === 0;
  const SEP_1 = new Date('2026-09-01T00:00:00+08:00');
  const afterSep1 = new Date() >= SEP_1;
  res.json({
    needs_class: noClass,
    suspended: noClass && afterSep1,
    message: afterSep1 && noClass ? '请先在设置中填写班级信息，否则无法发帖、评论和点赞。' : ''
  });
});

// GET /api/user/verify-status — Check if user has pending verification requests
router.get('/verify-status', auth, (req, res) => {
  const existing = db.prepare(
    "SELECT id, status FROM verification_requests WHERE user_id = ? AND status = 'pending'"
  ).get(req.user.userId);
  res.json({ pending: !!existing });
});

module.exports = router;
