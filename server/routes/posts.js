const { uploadToR2, deleteFromR2, sniffFileType, sniffDocx, sanitizeFilename, DOCX_MIME } = require("../storage");
const express = require('express');
const router = express.Router();
const db = require('../db');
const points = require('../points');
const { auth, optionalAuth } = require('./auth');

// Helper: get client IP (cf-connecting-ip first for Cloudflare Tunnel traffic)
function getIp(req) {
  return req.headers['cf-connecting-ip'] ||
         req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         '127.0.0.1';
}

// Helper: check if IP is banned (auto-clean expired)
function isBanned(ip) {
  db.prepare("DELETE FROM banned_ips WHERE banned_until IS NOT NULL AND banned_until < datetime('now')").run();
  const row = db.prepare('SELECT id FROM banned_ips WHERE ip = ?').get(ip);
  return !!row;
}

// Sep 1 deadline for class_number
const SEP_1 = new Date('2026-09-01T00:00:00+08:00');

// Helper: check if user must set class_number before posting/commenting/liking
function requireClassNumber(userId) {
  const user = db.prepare('SELECT class_number FROM users WHERE id = ?').get(userId);
  if (user && (!user.class_number || user.class_number === 0)) {
    const now = new Date();
    if (now >= SEP_1) {
      return false; // blocked
    }
  }
  return true; // ok
}

// Helper: decorate author with level info (name/color/emoji) for frontend badge rendering
function decorateAuthor(u) {
  if (!u) return u;
  const info = points.getLevelInfo(u.level || 1);
  u.level_name = info.name;
  u.level_color = info.color;
  u.level_emoji = info.emoji;
  u.nickname_color = u.nickname_color || '';
  u.points = u.points || 0;
  return u;
}

// Helper: get author info for a post
function getAuthorInfo(post) {
  if (post.is_anonymous || !post.user_id) return null;
  const user = db.prepare(
    'SELECT id, year, class_number, name, nickname, avatar_type, avatar_url, verified_label, is_external, school, level, nickname_color, points FROM users WHERE id = ?'
  ).get(post.user_id);
  return decorateAuthor(user);
}

// Helper: get author info for a comment
function getCommentAuthor(comment) {
  if (!comment.user_id) return null;
  const user = db.prepare(
    'SELECT id, year, class_number, name, nickname, avatar_type, avatar_url, verified_label, level, nickname_color, points FROM users WHERE id = ?'
  ).get(comment.user_id);
  return decorateAuthor(user);
}

// POST /api/posts — Create a post (requires auth)
router.post('/', auth, (req, res) => {
  // Check class_number after Sep 1
  if (!requireClassNumber(req.user.userId)) {
    return res.status(403).json({ error: '请先在设置中填写班级信息后再发帖' });
  }

  const ip = getIp(req);

  // Check if IP is banned (do this early before multer processes the body)
  if (isBanned(ip)) {
    return res.status(403).json({ error: '您的IP已被封禁，无法投稿' });
  }

  // Handle file upload if present — multer also populates req.body for multipart
  const upload = req.app.locals.upload;
  // [2026-08-04] 任务4: accept up to 9 files
  upload.array("mediaFiles", 9)(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      const { content, is_anonymous, category, is_pinned, use_privilege_pin, external_hidden, board_id } = req.body;
      const cat = category || 'other';

      // Validate content (read after multer, which populates req.body for multipart)
      if (!content || !content.trim()) {
        return res.status(400).json({ error: '内容不能为空' });
      }

      // Handle pinning — two paths:
      //   1) verified users (组织认证) can pin an announcement (no expiry)
      //   2) Lv.4+ users can use "置顶特权" on their own post (duration by level, quota-limited)
      let pinned = 0;
      let pinExpiresAt = null;
      const usePrivPin = use_privilege_pin === '1' || use_privilege_pin === 1 || use_privilege_pin === true;
      if (usePrivPin) {
        // 置顶特权（Lv.4+，只能置顶自己的帖子 —— 新建帖子即本人）
        const pu = db.prepare('SELECT level, daily_pin_used, daily_pin_date, weekly_pin_used, weekly_pin_week FROM users WHERE id = ?').get(req.user.userId);
        const quota = points.pinQuotaFor(pu ? (pu.level || 1) : 1);
        if (!quota) {
          return res.status(403).json({ error: '置顶特权 Lv.4 解锁' });
        }
        const today = points.todayUTC();
        const week = points.weekStr();
        if (quota.period === 'daily') {
          if (pu.daily_pin_date !== today) {
            db.prepare('UPDATE users SET daily_pin_used = 0, daily_pin_date = ? WHERE id = ?').run(today, req.user.userId);
            pu.daily_pin_used = 0;
          }
          if (pu.daily_pin_used >= quota.max) {
            return res.status(403).json({ error: '今日置顶次数已用完' });
          }
        } else {
          if (pu.weekly_pin_week !== week) {
            db.prepare('UPDATE users SET weekly_pin_used = 0, weekly_pin_week = ? WHERE id = ?').run(week, req.user.userId);
            pu.weekly_pin_used = 0;
          }
          if (pu.weekly_pin_used >= quota.max) {
            return res.status(403).json({ error: '本周置顶次数已用完' });
          }
        }
        pinned = 1;
        pinExpiresAt = db.prepare("SELECT datetime('now', ?) AS t").get(`+${quota.durationHours} hours`).t;
        // 置顶后立即扣减次数，不可撤销
        if (quota.period === 'daily') {
          db.prepare('UPDATE users SET daily_pin_used = daily_pin_used + 1 WHERE id = ?').run(req.user.userId);
        } else {
          db.prepare('UPDATE users SET weekly_pin_used = weekly_pin_used + 1 WHERE id = ?').run(req.user.userId);
        }
      } else if (is_pinned === '1' || is_pinned === 1 || is_pinned === true) {
        const user = db.prepare('SELECT verified_label, is_verified FROM users WHERE id = ?').get(req.user.userId);
        if (user && (user.verified_label || user.is_verified)) {
          pinned = 1;
        } else {
          return res.status(403).json({ error: '只有认证用户才能发布置顶通知' });
        }
      }

      // [2026-08-04] 任务4: Validate each uploaded file by magic bytes
      // [2026-08-31] 增加 Word 文档（.docx）支持，防宏病毒
      const files = req.files || [];
      if (files.length > 3) {
        return res.status(400).json({ error: '最多上传 3 个文件' });
      }
      const mediaFiles = [];
      let docxFile = null;
      for (const f of files) {
        const sniffed = sniffFileType(f.buffer);
        if (sniffed) {
          f.sniffedType = sniffed;
          mediaFiles.push(f);
          continue;
        }
        // 不是图片/视频 → 尝试按 Word 文档校验
        const docxCheck = sniffDocx(f.buffer);
        if (docxCheck.ok) {
          if (docxFile) {
            return res.status(400).json({ error: '每篇帖子最多上传 1 个 Word 文档' });
          }
          docxFile = f;
          continue;
        }
        if (docxCheck.error === 'macro' || docxCheck.error === 'activex') {
          return res.status(400).json({ error: '检测到该 Word 文档包含宏或 ActiveX 控件，为防宏病毒已拒绝上传（请另存为无宏的 .docx）' });
        }
        return res.status(400).json({ error: '文件内容校验失败：仅支持图片（jpg/png/gif/webp）、视频（mp4/webm）或 Word 文档（.docx，不支持 .doc/.docm）' });
      }

      // [2026-08-04] 任务4: Upload all files, build URL array
      const mediaUrls = [];
      for (const f of mediaFiles) {
        mediaUrls.push(await uploadToR2(f));
      }
      const mediaUrl = mediaUrls.length > 0 ? mediaUrls[0] : null;
      const mediaUrlsJson = mediaUrls.length > 0 ? JSON.stringify(mediaUrls) : null;

      // [2026-08-31] Upload Word doc（强制附件下载，杜绝浏览器内联执行）
      let docxUrl = null;
      let docxName = null;
      if (docxFile) {
        // multer/busboy 默认按 latin1 解码文件名，中文会乱码，转回 UTF-8
        let rawName = docxFile.originalname || 'document.docx';
        try {
          const fixed = Buffer.from(rawName, 'latin1').toString('utf8');
          if (!fixed.includes('\uFFFD')) rawName = fixed;
        } catch (_) {}
        docxName = sanitizeFilename(rawName);
        const disposition = `attachment; filename="document.docx"; filename*=UTF-8''${encodeURIComponent(docxName)}`;
        docxUrl = await uploadToR2(docxFile, null, { contentType: DOCX_MIME, contentDisposition: disposition });
      }
      const anonymous = (is_anonymous === '1' || is_anonymous === 1 || is_anonymous === true) ? 1 : 0;
      const extHidden = (external_hidden === '1' || external_hidden === 1 || external_hidden === true) ? 1 : 0;

      // [2026-08-07] Validate board_id if provided
      let boardId = null;
      if (board_id && parseInt(board_id) > 0) {
        const b = db.prepare('SELECT id FROM boards WHERE id = ?').get(parseInt(board_id));
        if (!b) return res.status(400).json({ error: '板块不存在' });
        boardId = b.id;
      }

      const stmt = db.prepare(
        'INSERT INTO posts (content, media_url, media_urls, ip, user_id, is_anonymous, category, pinned, pin_expires_at, external_hidden, board_id, docx_url, docx_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      const result = stmt.run(content.trim(), mediaUrl, mediaUrlsJson, ip, req.user.userId, anonymous, cat, pinned, pinExpiresAt, extHidden, boardId, docxUrl, docxName);
      const postId = result.lastInsertRowid;

      // [2026-08-16] 发帖 +3 分（每日上限 3，仅首帖计入）
      points.award(req.user.userId, 3, 'post', postId);

      // [2026-08-03] 任务5: create poll if provided
      const pollQuestion = (req.body.poll_question || '').trim();
      let pollOptions = [];
      try { pollOptions = JSON.parse(req.body.poll_options || '[]'); } catch { pollOptions = []; }
      pollOptions = pollOptions.filter(o => o && (o.text || '').trim());

      if (pollQuestion && pollOptions.length >= 2 && pollOptions.length <= 8) {
        const pollResult = db.prepare('INSERT INTO polls (post_id, question) VALUES (?, ?)').run(postId, pollQuestion);
        const pollId = pollResult.lastInsertRowid;
        const optStmt = db.prepare('INSERT INTO poll_options (poll_id, text) VALUES (?, ?)');
        for (const opt of pollOptions) {
          optStmt.run(pollId, (opt.text || '').trim());
        }
      }

      const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
      post.author = getAuthorInfo(post);
      // Attach poll data to response
      if (pollQuestion && pollOptions.length >= 2) {
        const poll = db.prepare('SELECT * FROM polls WHERE post_id = ?').get(postId);
        if (poll) {
          poll.options = db.prepare('SELECT * FROM poll_options WHERE poll_id = ?').all(poll.id);
          post.poll = poll;
        }
      }
      res.status(201).json(post);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: '服务器错误' });
    }
  });
});

// GET /api/posts — List posts (public, optional auth for like status)
router.get('/', optionalAuth, (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    // Build WHERE clause with optional category filter
    // [2026-08-07] Repost refactor: reposts don't appear in square/category
    // [2026-08-08] Board posts don't appear in home feed (board content lives in board pages)
    // [2026-08-31] 应 Tintin 要求：前期内容少，分区帖子同步显示在主页（带分区徽章）
    let whereClause = 'WHERE p.hidden = 0 AND p.repost_of IS NULL';
    const params = [];

    // External users cannot see posts marked external_hidden
    if (req.user && req.user.is_external) {
      whereClause += ' AND (p.external_hidden = 0 OR p.external_hidden IS NULL)';
    }

    // Onboarding welcome post: visible to guests, users registered <12h ago, and founder
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

    if (req.query.cat) {
      whereClause += ' AND p.category = ?';
      params.push(req.query.cat);
    }

    // Count total (non-hidden)
    const countRow = db.prepare(`SELECT COUNT(*) as total FROM posts p ${whereClause}`).get(...params);
    const total = countRow.total;

    // Fetch posts with like and comment counts
    const posts = db.prepare(`
      SELECT
        p.*,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id AND hidden = 0) as comment_count
      FROM posts p
      ${whereClause}
      ORDER BY p.pinned DESC, CASE WHEN p.pinned = 1 THEN p.created_at END ASC, p.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // Check founder view — only works if user has role 'founder'
    const founderView = req.query.founder_view === '1' && req.user;
    let isFounder = false;
    if (founderView) {
      const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.userId);
      isFounder = user && user.role === 'founder';
    }

    // [2026-08-03] 任务5: helper to attach poll data
    function attachPoll(post) {
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
    }

    // Attach author info to each post
    const enrichedPosts = posts.map(post => {
      post.author = getAuthorInfo(post);
      // Founder view: reveal real author for anonymous posts
      if (isFounder && post.is_anonymous && post.user_id) {
        const realAuthor = db.prepare(
          'SELECT id, year, class_number, name, nickname, verified_label FROM users WHERE id = ?'
        ).get(post.user_id);
        if (realAuthor) {
          post.real_author = realAuthor;
        }
      }
      // Check if current user liked this post
      if (req.user) {
        const liked = db.prepare(
          'SELECT id FROM likes WHERE post_id = ? AND user_id = ?'
        ).get(post.id, req.user.userId);
        post.user_liked = !!liked;
      } else {
        // Check by IP for legacy / non-authed users
        const liked = db.prepare(
          'SELECT id FROM likes WHERE post_id = ? AND ip = ?'
        ).get(post.id, getIp(req));
        post.user_liked = !!liked;
      }
      // Enrich repost data
      if (post.repost_of) {
        const originalPost = db.prepare(`
          SELECT p.*, u.nickname, u.name FROM posts p
          LEFT JOIN users u ON p.user_id = u.id
          WHERE p.id = ?
        `).get(post.repost_of);
        if (originalPost) {
          post.repost_content = originalPost.content;
          post.repost_media_url = originalPost.media_url;
          post.repost_media_urls = originalPost.media_urls; // [2026-08-04] 任务4
          post.repost_author = originalPost.is_anonymous
            ? '匿名'
            : (originalPost.nickname || originalPost.name || '用户');
        }
      }
      return post;
    });

    // [2026-08-03] 任务5: attach poll data
    enrichedPosts.forEach(p => attachPoll(p));

    // [2026-08-07] Attach board info
    enrichedPosts.forEach(p => {
      if (p.board_id) {
        p.board = db.prepare('SELECT id, name, icon FROM boards WHERE id = ?').get(p.board_id);
      }
    });

    res.json({
      posts: enrichedPosts,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/posts/:id — Get single post (public, optional auth)
router.get('/:id', optionalAuth, (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    let whereExtra = '';
    // External users cannot view posts marked external_hidden
    if (req.user && req.user.is_external) {
      whereExtra = ' AND (p.external_hidden = 0 OR p.external_hidden IS NULL)';
    }
    const post = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id AND hidden = 0) as comment_count
      FROM posts p
      WHERE p.id = ? AND p.hidden = 0${whereExtra}
    `).get(postId);

    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // Attach author
    post.author = getAuthorInfo(post);

    // Founder view
    if (req.query.founder_view === '1' && req.user && post.is_anonymous && post.user_id) {
      const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.userId);
      if (user && user.role === 'founder') {
        const realAuthor = db.prepare(
          'SELECT id, year, class_number, name, nickname, verified_label FROM users WHERE id = ?'
        ).get(post.user_id);
        if (realAuthor) post.real_author = realAuthor;
      }
    }

    // Check if current user liked
    if (req.user) {
      const liked = db.prepare(
        'SELECT id FROM likes WHERE post_id = ? AND user_id = ?'
      ).get(post.id, req.user.userId);
      post.user_liked = !!liked;
    }

    // Enrich repost data
    if (post.repost_of) {
      const originalPost = db.prepare(`
        SELECT p.*, u.nickname, u.name FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        WHERE p.id = ?
      `).get(post.repost_of);
      if (originalPost) {
        post.repost_content = originalPost.content;
        post.repost_media_url = originalPost.media_url;
        post.repost_media_urls = originalPost.media_urls; // [2026-08-04] 任务4
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
        // [2026-08-07] Repost refactor: attach original post's poll data
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

    // [2026-08-07] Attach board info
    if (post.board_id) {
      post.board = db.prepare('SELECT id, name, icon FROM boards WHERE id = ?').get(post.board_id);
    }

    // [2026-08-07] Include likes list if viewer is the post author
    if (req.user && post.user_id === req.user.userId) {
      const likers = db.prepare(`
        SELECT u.id, u.name, u.nickname, u.avatar_type, u.avatar_url, u.verified_label
        FROM likes l JOIN users u ON l.user_id = u.id
        WHERE l.post_id = ?
        ORDER BY l.created_at DESC
        LIMIT 50
      `).all(postId);
      post.likes = likers;
    }

    res.json({ post });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/posts/:id/like — Toggle like (requires auth)
router.post('/:id/like', auth, (req, res) => {
  // Check class_number after Sep 1
  if (!requireClassNumber(req.user.userId)) {
    return res.status(403).json({ error: '请先在设置中填写班级信息后再点赞' });
  }

  try {
    const postId = parseInt(req.params.id);
    const userId = req.user.userId;

    // Check if post exists
    const post = db.prepare('SELECT id FROM posts WHERE id = ? AND hidden = 0').get(postId);
    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // Check if already liked (by user_id for authenticated users)
    const existing = db.prepare('SELECT id FROM likes WHERE post_id = ? AND user_id = ?').get(postId, userId);

    if (existing) {
      // Unlike
      db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(postId, userId);
      const count = db.prepare('SELECT COUNT(*) as count FROM likes WHERE post_id = ?').get(postId);
      res.json({ liked: false, count: count.count });
    } else {
      // Like - store with user_id and IP
      const ip = getIp(req);
      db.prepare('INSERT INTO likes (post_id, user_id, ip) VALUES (?, ?, ?)').run(postId, userId, ip);
      const count = db.prepare('SELECT COUNT(*) as count FROM likes WHERE post_id = ?').get(postId);

      // Notify post owner + award points (self-like 不计分)
      const postOwner = db.prepare('SELECT user_id, content FROM posts WHERE id = ?').get(postId);
      if (postOwner && postOwner.user_id && postOwner.user_id !== userId) {
        const snippet = (postOwner.content || '').substring(0, 50);
        db.prepare(
          'INSERT INTO notifications (user_id, type, title, content, post_id) VALUES (?, ?, ?, ?, ?)'
        ).run(postOwner.user_id, 'post_liked', '收到点赞', `${req.user.name} 赞了你的帖子：${snippet}`, postId);
        // [2026-08-16] 收到的赞 +1（每日上限 10，10 秒去重）
        points.award(postOwner.user_id, 1, 'liked', postId, 'target');
      }

      res.json({ liked: true, count: count.count });
    }
  } catch (err) {
    // Handle UNIQUE constraint violation gracefully
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const postId = parseInt(req.params.id);
      const count = db.prepare('SELECT COUNT(*) as count FROM likes WHERE post_id = ?').get(postId);
      return res.json({ liked: true, count: count.count });
    }
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/posts/:id/comments — Get comments for a post (public, optional auth for like status)
router.get('/:id/comments', optionalAuth, (req, res) => {
  try {
    const postId = parseInt(req.params.id);

    const post = db.prepare('SELECT id FROM posts WHERE id = ? AND hidden = 0').get(postId);
    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    const allComments = db.prepare(`
      SELECT c.*, u.nickname, u.name FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.post_id = ? AND c.hidden = 0 ORDER BY c.created_at ASC
    `).all(postId);

    // Separate top-level comments and replies
    const topComments = allComments.filter(c => !c.parent_comment_id);
    const replies = allComments.filter(c => c.parent_comment_id);

    // Attach author info and like counts
    const enriched = topComments.map(c => {
      if (c.is_anonymous) {
        // [2026-08-08] 匿名评论：隐藏真实作者，创始人可解密
        c.author = null;
        c.nickname = null;
        c.name = null;
        if (req.query.founder_view === '1' && req.user) {
          const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.userId);
          if (u && u.role === 'founder') {
            const realAuthor = db.prepare(
              'SELECT id, year, class_number, name, nickname, verified_label FROM users WHERE id = ?'
            ).get(c.user_id);
            if (realAuthor) c.real_author = realAuthor;
          }
        }
      } else {
        c.author = getCommentAuthor(c);
      }
      const likeCount = db.prepare(
        'SELECT COUNT(*) as count FROM comment_likes WHERE comment_id = ?'
      ).get(c.id);
      c.like_count = likeCount.count;

      // Check if current user liked this comment
      if (req.user) {
        const liked = db.prepare(
          'SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?'
        ).get(c.id, req.user.userId);
        c.user_liked = !!liked;
      }

      // Nest replies
      c.replies = replies
        .filter(r => r.parent_comment_id === c.id)
        .map(r => {
          if (r.is_anonymous) {
            r.author = null;
            r.nickname = null;
            r.name = null;
            if (req.query.founder_view === '1' && req.user) {
              const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.userId);
              if (u && u.role === 'founder') {
                const realAuthor = db.prepare(
                  'SELECT id, year, class_number, name, nickname, verified_label FROM users WHERE id = ?'
                ).get(r.user_id);
                if (realAuthor) r.real_author = realAuthor;
              }
            }
          } else {
            r.author = getCommentAuthor(r);
          }
          const rLikeCount = db.prepare(
            'SELECT COUNT(*) as count FROM comment_likes WHERE comment_id = ?'
          ).get(r.id);
          r.like_count = rLikeCount.count;
          if (req.user) {
            const liked = db.prepare(
              'SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?'
            ).get(r.id, req.user.userId);
            r.user_liked = !!liked;
          }
          return r;
        });

      return c;
    });

    res.json({ comments: enriched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/posts/:id/comments — Add a comment (requires auth)
router.post('/:id/comments', auth, (req, res) => {
  // Check class_number after Sep 1
  if (!requireClassNumber(req.user.userId)) {
    return res.status(403).json({ error: '请先在设置中填写班级信息后再评论' });
  }

  try {
    const postId = parseInt(req.params.id);
    const { content, parent_comment_id, is_anonymous } = req.body;
    const ip = getIp(req);

    // Validate
    if (!content || !content.trim()) {
      return res.status(400).json({ error: '评论内容不能为空' });
    }

    // Check post exists
    const post = db.prepare('SELECT id, user_id FROM posts WHERE id = ? AND hidden = 0').get(postId);
    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // Check banned
    if (isBanned(ip)) {
      return res.status(403).json({ error: '您的IP已被封禁，无法评论' });
    }

    const parentId = parent_comment_id ? parseInt(parent_comment_id) : null;
    const anonymous = (is_anonymous === '1' || is_anonymous === 1 || is_anonymous === true) ? 1 : 0;

    const result = db.prepare(
      'INSERT INTO comments (post_id, content, ip, user_id, parent_comment_id, is_anonymous) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(postId, content.trim(), ip, req.user.userId, parentId, anonymous);

    // [2026-08-16] 评论 +1（每日上限 5，10 秒去重）
    points.award(req.user.userId, 1, 'comment', result.lastInsertRowid, 'reason');

    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(result.lastInsertRowid);
    if (comment.is_anonymous) {
      comment.author = null;
    } else {
      comment.author = getCommentAuthor(comment);
    }

    const commenterName = anonymous ? '匿名用户' : req.user.name;

    // Notify post owner about new comment
    if (post.user_id && post.user_id !== req.user.userId) {
      const postData = db.prepare('SELECT content FROM posts WHERE id = ?').get(postId);
      const snippet = (postData ? postData.content : '').substring(0, 50);
      db.prepare(
        'INSERT INTO notifications (user_id, type, title, content, post_id) VALUES (?, ?, ?, ?, ?)'
      ).run(post.user_id, 'post_commented', '收到评论', `${commenterName} 评论了你的帖子：${snippet}`, postId);
    }

    // If this is a reply, notify the parent comment owner
    if (parentId) {
      const parentComment = db.prepare('SELECT user_id, post_id FROM comments WHERE id = ?').get(parentId);
      if (parentComment && parentComment.user_id && parentComment.user_id !== req.user.userId) {
        db.prepare(
          'INSERT INTO notifications (user_id, type, title, content, post_id) VALUES (?, ?, ?, ?, ?)'
        ).run(parentComment.user_id, 'comment_reply', '收到回复', `${commenterName} 回复了你的评论：${comment.content.substring(0, 50)}`, parentComment.post_id);
      }
    }

    res.status(201).json(comment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/posts/:id/report — Report a post (requires auth)
router.post('/:id/report', auth, (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const { reason, involves_me } = req.body;
    const ip = getIp(req);

    // Check post exists
    const post = db.prepare('SELECT id, report_count, user_id FROM posts WHERE id = ? AND hidden = 0').get(postId);
    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // Dedup: one report per user per post
    const existing = db.prepare('SELECT id FROM reports WHERE post_id = ? AND user_id = ?').get(postId, req.user.userId);
    if (existing) {
      return res.status(400).json({ error: '你已举报过这条帖子' });
    }

    // 涉及自己举报必须提供简要说明（民法典1195条初步依据精神）
    if (involves_me && (!(reason || '').trim() || (reason || '').trim() === '涉及自己')) {
      return res.status(400).json({ error: '请补充说明你与该内容的关系' });
    }

    const reportReason = (((reason || '').trim() + (involves_me ? '（涉及本人举报）' : '')) || '').trim();

    // Insert report
    db.prepare(
      'INSERT INTO reports (post_id, user_id, ip, reason) VALUES (?, ?, ?, ?)'
    ).run(postId, req.user.userId, ip, reportReason);

    // Increment report count
    const newCount = post.report_count + 1;
    db.prepare('UPDATE posts SET report_count = ? WHERE id = ?').run(newCount, postId);

    // Immediate hide if involves the reporter themselves; otherwise auto-hide at 5 reports
    if (involves_me || newCount >= 5) {
      db.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(postId);
      const why = involves_me ? '因涉及本人举报（隐私保护）立即隐藏' : `因被举报 ${newCount} 次触发自动隐藏`;
      // Log system action
      db.prepare('INSERT INTO admin_logs (action, target_type, target_id, detail) VALUES (?, ?, ?, ?)').run(
        'auto_hide_post', 'post', String(postId),
        `[系统] 帖子 #${postId} ${why}`
      );
      // Notify post owner
      if (post.user_id) {
        db.prepare(
          'INSERT INTO notifications (user_id, type, title, content, post_id) VALUES (?, ?, ?, ?, ?)'
        ).run(post.user_id, 'post_hidden', '帖子被隐藏',
          `你的帖子 #${postId} ${why}，如有异议可在申诉中说明`, postId);
      }
    }

    res.json({ reported: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/posts/:id/comments/:commentId/report — Report a comment (requires auth)
router.post('/:id/comments/:commentId/report', auth, (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const commentId = parseInt(req.params.commentId);
    const { reason, involves_me } = req.body;
    const ip = getIp(req);

    const comment = db.prepare('SELECT id, report_count, user_id FROM comments WHERE id = ? AND hidden = 0').get(commentId);
    if (!comment) {
      return res.status(404).json({ error: '评论不存在' });
    }

    // Dedup: one report per user per comment
    const existing = db.prepare('SELECT id FROM comment_reports WHERE comment_id = ? AND user_id = ?').get(commentId, req.user.userId);
    if (existing) {
      return res.status(400).json({ error: '你已举报过这条评论' });
    }

    // 涉及自己举报必须提供简要说明
    if (involves_me && (!(reason || '').trim() || (reason || '').trim() === '涉及自己')) {
      return res.status(400).json({ error: '请补充说明你与该内容的关系' });
    }

    const reportReason = (((reason || '').trim() + (involves_me ? '（涉及本人举报）' : '')) || '').trim();

    db.prepare(
      'INSERT INTO comment_reports (comment_id, user_id, ip, reason) VALUES (?, ?, ?, ?)'
    ).run(commentId, req.user.userId, ip, reportReason);

    const newCount = comment.report_count + 1;
    db.prepare('UPDATE comments SET report_count = ? WHERE id = ?').run(newCount, commentId);

    // Immediate hide if involves the reporter themselves; otherwise auto-hide at 5 reports
    if (involves_me || newCount >= 5) {
      db.prepare('UPDATE comments SET hidden = 1 WHERE id = ?').run(commentId);
      const why = involves_me ? '因涉及本人举报（隐私保护）立即隐藏' : `因被举报 ${newCount} 次触发自动隐藏`;
      db.prepare('INSERT INTO admin_logs (action, target_type, target_id, detail) VALUES (?, ?, ?, ?)').run(
        'auto_hide_comment', 'comment', String(commentId),
        `[系统] 帖子 #${postId} 下的评论 #${commentId} ${why}`
      );
      if (comment.user_id) {
        db.prepare(
          'INSERT INTO notifications (user_id, type, title, content, post_id) VALUES (?, ?, ?, ?, ?)'
        ).run(comment.user_id, 'comment_hidden', '评论被隐藏',
          `你的评论 #${commentId} ${why}`, postId);
      }
    }

    res.json({ reported: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/posts/:id/comments/:commentId/like — Toggle comment like (requires auth)
router.post('/:id/comments/:commentId/like', auth, (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId);
    const userId = req.user.userId;

    const existing = db.prepare(
      'SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?'
    ).get(commentId, userId);

    if (existing) {
      db.prepare('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?').run(commentId, userId);
    } else {
      db.prepare('INSERT INTO comment_likes (comment_id, user_id, ip) VALUES (?, ?, ?)').run(commentId, userId, getIp(req));
      // [2026-08-16] 评论获赞 +1（自赞不计分，10 秒去重）
      const cAuthor = db.prepare('SELECT user_id FROM comments WHERE id = ?').get(commentId);
      if (cAuthor && cAuthor.user_id && cAuthor.user_id !== userId) {
        points.award(cAuthor.user_id, 1, 'liked', commentId, 'target');
      }
    }

    const count = db.prepare('SELECT COUNT(*) as count FROM comment_likes WHERE comment_id = ?').get(commentId);
    res.json({ liked: !existing, count: count.count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/posts/:id/repost — Repost a post (requires auth)
router.post('/:id/repost', auth, (req, res) => {
  // Check class_number after Sep 1
  if (!requireClassNumber(req.user.userId)) {
    return res.status(403).json({ error: '请先在设置中填写班级信息后再转发' });
  }

  try {
    const postId = parseInt(req.params.id);
    const ip = getIp(req);

    // Check IP ban
    if (isBanned(ip)) {
      return res.status(403).json({ error: '您的IP已被封禁，无法转发' });
    }

    const original = db.prepare('SELECT id, user_id FROM posts WHERE id = ? AND hidden = 0').get(postId);
    if (!original) return res.status(404).json({ error: '帖子不存在' });

    // One repost per user per post
    const existing = db.prepare('SELECT id FROM posts WHERE repost_of = ? AND user_id = ?').get(postId, req.user.userId);
    if (existing) return res.status(409).json({ error: '你已经转发过这个帖子了' });

    // Create repost — ip is required (NOT NULL), category defaults to 'other'
    db.prepare(
      'INSERT INTO posts (content, user_id, repost_of, is_anonymous, ip) VALUES (?, ?, ?, ?, ?)'
    ).run('', req.user.userId, postId, 0, ip);

    // Update repost count
    db.prepare('UPDATE posts SET repost_count = repost_count + 1 WHERE id = ?').run(postId);

    // Notify original post owner
    if (original.user_id && original.user_id !== req.user.userId) {
      db.prepare(
        'INSERT INTO notifications (user_id, type, title, content, post_id) VALUES (?, ?, ?, ?, ?)'
      ).run(original.user_id, 'post_reposted', '帖子被转发', `${req.user.name} 转发了你的帖子`, postId);
    }

    const count = db.prepare('SELECT repost_count FROM posts WHERE id = ?').get(postId);
    res.json({ reposted: true, repost_count: count.repost_count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// [2026-08-07] GET /api/posts/:id/likes — Get users who liked a post
router.get('/:id/likes', auth, (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const post = db.prepare('SELECT id FROM posts WHERE id = ? AND hidden = 0').get(postId);
    if (!post) return res.status(404).json({ error: '帖子不存在' });

    const likers = db.prepare(`
      SELECT u.id, u.name, u.nickname, u.avatar_type, u.avatar_url, u.verified_label
      FROM likes l JOIN users u ON l.user_id = u.id
      WHERE l.post_id = ?
      ORDER BY l.created_at DESC
      LIMIT 50
    `).all(postId);

    res.json({ likers });
  } catch (err) {
    console.error('Get likes error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// [2026-08-03] 任务5: POST /api/posts/:id/poll/vote — Vote on a poll
router.post('/:id/poll/vote', auth, (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const { option_id } = req.body;
    const optionId = parseInt(option_id);
    if (!optionId) return res.status(400).json({ error: '请选择一个选项' });

    const poll = db.prepare('SELECT id FROM polls WHERE post_id = ?').get(postId);
    if (!poll) return res.status(404).json({ error: '该帖子没有投票' });

    const option = db.prepare('SELECT id FROM poll_options WHERE id = ? AND poll_id = ?').get(optionId, poll.id);
    if (!option) return res.status(400).json({ error: '选项不存在' });

    // One person one vote — switch vote if already voted
    const existing = db.prepare('SELECT id, option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(poll.id, req.user.userId);
    if (existing) {
      // Decrement old option count
      db.prepare('UPDATE poll_options SET vote_count = MAX(0, vote_count - 1) WHERE id = ?').run(existing.option_id);
      // Delete old vote
      db.prepare('DELETE FROM poll_votes WHERE id = ?').run(existing.id);
    }

    // Insert new vote
    db.prepare('INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)').run(poll.id, optionId, req.user.userId);
    db.prepare('UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = ?').run(optionId);

    // Return updated poll
    const updatedOptions = db.prepare('SELECT * FROM poll_options WHERE poll_id = ?').all(poll.id);
    const totalVotes = updatedOptions.reduce((sum, o) => sum + (o.vote_count || 0), 0);
    res.json({ options: updatedOptions, total_votes: totalVotes, my_vote: optionId, switched: !!existing });
  } catch (err) {
    console.error('Poll vote error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// [2026-08-04] 任务3: DELETE /api/comments/:id — Delete own comment (requires auth)
router.delete('/comments/:id', auth, (req, res) => {
  try {
    const commentId = parseInt(req.params.id);
    const comment = db.prepare('SELECT id, user_id, post_id FROM comments WHERE id = ?').get(commentId);

    if (!comment) {
      return res.status(404).json({ error: '评论不存在' });
    }

    // Check permission: comment author or admin/founder
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.userId);
    const isStaff = user && (user.role === 'founder' || user.role === 'admin');
    if (comment.user_id !== req.user.userId && !isStaff) {
      return res.status(403).json({ error: '只能删除自己的评论' });
    }

    // Delete related records first (foreign key cascade)
    db.prepare('DELETE FROM comment_likes WHERE comment_id = ?').run(commentId);
    db.prepare('DELETE FROM comment_reports WHERE comment_id = ?').run(commentId);
    // Also delete replies to this comment
    const replyIds = db.prepare('SELECT id, user_id FROM comments WHERE parent_comment_id = ?').all(commentId);
    for (const r of replyIds) {
      db.prepare('DELETE FROM comment_likes WHERE comment_id = ?').run(r.id);
      db.prepare('DELETE FROM comment_reports WHERE comment_id = ?').run(r.id);
      db.prepare('DELETE FROM comments WHERE id = ?').run(r.id);
      // [2026-08-31] 删评论撤销积分
      if (r.user_id) points.revoke(r.user_id, 'comment', r.id);
    }
    db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
    // [2026-08-31] 删评论撤销积分（含被删回复的积分）
    if (comment.user_id) points.revoke(comment.user_id, 'comment', commentId);

    // Handle notifications: mark related notifications with a note
    db.prepare("UPDATE notifications SET content = content || '（评论已删除）' WHERE type IN ('post_commented','comment_reply') AND content LIKE '%评论%' AND id IN (SELECT id FROM notifications WHERE user_id = ?)").run(comment.user_id);

    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete comment error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/posts/:id/delete — Delete own post (requires auth, must be owner)
router.post('/:id/delete', auth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const post = db.prepare('SELECT id, user_id, media_url, media_urls, docx_url FROM posts WHERE id = ?').get(postId);

    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // Check ownership
    if (post.user_id !== req.user.userId) {
      return res.status(403).json({ error: '只能删除自己的帖子' });
    }

    // [2026-08-31] 先记录文件 URL（删行后就查不到了）
    const docxUrl = post.docx_url;
    const mediaUrls = [];
    if (post.media_url) mediaUrls.push(post.media_url);
    try { mediaUrls.push(...(JSON.parse(post.media_urls || '[]'))); } catch (_) {}

    // Delete related records first
    db.prepare('DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE post_id = ?)').run(postId);
    db.prepare('DELETE FROM comments WHERE post_id = ?').run(postId);
    db.prepare('DELETE FROM likes WHERE post_id = ?').run(postId);
    db.prepare('DELETE FROM reports WHERE post_id = ?').run(postId);
    // [2026-08-03] 任务5: clean up poll data
    db.prepare('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE post_id = ?)').run(postId);
    db.prepare('DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM polls WHERE post_id = ?)').run(postId);
    db.prepare('DELETE FROM polls WHERE post_id = ?').run(postId);
    db.prepare('DELETE FROM posts WHERE id = ?').run(postId);

    // [2026-08-31] 删帖撤销积分（发帖 + 该帖所有评论），否则积分虚高（用户反馈 #57）
    if (post.user_id) points.revoke(post.user_id, 'post', postId);
    const postComments = db.prepare('SELECT id, user_id FROM comments WHERE post_id = ?').all(postId);
    for (const c of postComments) {
      if (c.user_id) points.revoke(c.user_id, 'comment', c.id);
    }

    // [2026-08-31] 清理 R2 上的文件（图片/视频 + Word 文档）
    if (docxUrl) { try { await deleteFromR2(docxUrl); } catch (_) {} }
    for (const u of new Set(mediaUrls)) { try { await deleteFromR2(u); } catch (_) {} }

    res.json({ deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// [2026-08-09] Unpin a post — post author or admin/founder
router.post('/:id/unpin', auth, (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const post = db.prepare('SELECT id, pinned, user_id FROM posts WHERE id = ?').get(postId);
    if (!post) {
      return res.status(404).json({ error: '帖子不存在' });
    }
    if (!post.pinned) {
      return res.status(400).json({ error: '帖子未置顶' });
    }

    const user = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(req.user.userId);
    const isAuthor = post.user_id === req.user.userId;
    const isStaff = user && (user.role === 'founder' || user.role === 'admin');
    if (!isAuthor && !isStaff) {
      return res.status(403).json({ error: '只有作者或管理员可以取消置顶' });
    }

    db.prepare('UPDATE posts SET pinned = 0 WHERE id = ?').run(postId);

    // Admin log (staff unpinning someone else's post)
    if (!isAuthor) {
      db.prepare(
        'INSERT INTO admin_logs (action, target_type, target_id, detail) VALUES (?, ?, ?, ?)'
      ).run('unpin_post', 'post', String(postId), `[${user.name}] 取消置顶帖子 #${postId}`);
      if (post.user_id) {
        db.prepare(
          'INSERT INTO notifications (user_id, type, title, content, post_id) VALUES (?, ?, ?, ?, ?)'
        ).run(post.user_id, 'post_unpinned', '帖子取消置顶', `你的帖子 #${postId} 已被取消置顶`, postId);
      }
    }

    res.json({ pinned: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
