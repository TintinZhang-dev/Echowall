const express = require('express');
const multer = require('multer');
const router = express.Router();
const db = require('../db');
const { auth } = require('./auth');
const { uploadToR2, deleteFromR2, sniffFileType } = require('../storage');

// Dedicated multer for avatars — 2MB limit, memory storage
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

const EXT_MAP = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp'
};

// POST /api/user/avatar — Upload/replace avatar
router.post('/', auth, (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: '头像文件不能超过 2MB' });
      }
      return res.status(400).json({ error: '上传失败，请重试' });
    }
    try {
    // Validate file presence
    if (!req.file) {
      return res.status(400).json({ error: '请选择要上传的头像图片' });
    }

    // Sniff real file type from magic bytes (server-side, never trust client)
    const sniffedType = sniffFileType(req.file.buffer);
    if (!sniffedType || !EXT_MAP[sniffedType]) {
      return res.status(400).json({ error: '文件必须是 jpg/png/gif/webp 图片' });
    }

    // Upload to R2 with avatar- prefix key
    const ext = EXT_MAP[sniffedType];
    req.file.sniffedType = sniffedType;
    const avatarKey = `avatar-${req.user.userId}-${Date.now()}.${ext}`;
    const avatarUrl = await uploadToR2(req.file, avatarKey);

    // Delete old avatar from R2 if exists
    const user = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.userId);
    if (user && user.avatar_url) {
      await deleteFromR2(user.avatar_url);
    }

    // Update DB
    db.prepare('UPDATE users SET avatar_url = ?, avatar_type = ? WHERE id = ?')
      .run(avatarUrl, 'custom', req.user.userId);

    res.json({ avatar_url: avatarUrl });
    } catch (err) {
      console.error('Avatar upload error:', err);
      res.status(500).json({ error: '服务器错误' });
    }
  });
});

// DELETE /api/user/avatar — Restore default avatar
router.delete('/', auth, async (req, res) => {
  try {
    const user = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // Delete old avatar from R2 if exists
    if (user.avatar_url) {
      await deleteFromR2(user.avatar_url);
    }

    // Reset to default
    db.prepare("UPDATE users SET avatar_url = '', avatar_type = 'default' WHERE id = ?")
      .run(req.user.userId);

    res.json({ avatar_url: '' });
  } catch (err) {
    console.error('Avatar delete error:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
