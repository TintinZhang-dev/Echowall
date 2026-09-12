const Database = require('better-sqlite3');
const path = require('path');
const { siteConfig } = require('./config');

const dbPath = path.join(__dirname, '..', 'data.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    media_url TEXT,
    nickname TEXT DEFAULT '',
    ip TEXT NOT NULL,
    pinned INTEGER DEFAULT 0,
    report_count INTEGER DEFAULT 0,
    hidden INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    nickname TEXT DEFAULT '',
    ip TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id)
  );

  CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(post_id, ip),
    FOREIGN KEY (post_id) REFERENCES posts(id)
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    reason TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id)
  );

  CREATE TABLE IF NOT EXISTS banned_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL UNIQUE,
    reason TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    class_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    nickname TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    avatar_type TEXT DEFAULT 'default',
    avatar_url TEXT DEFAULT '',
    is_verified INTEGER DEFAULT 0,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(year, class_number, name)
  );

  CREATE TABLE IF NOT EXISTS appeals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    class_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    reason TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS admin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrations: add columns if they don't exist (safe to run on existing DBs)
function columnExists(table, column) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  return info.some(col => col.name === column);
}

if (!columnExists('posts', 'user_id')) {
  db.exec(`ALTER TABLE posts ADD COLUMN user_id INTEGER REFERENCES users(id)`);
}
if (!columnExists('posts', 'is_anonymous')) {
  db.exec(`ALTER TABLE posts ADD COLUMN is_anonymous INTEGER DEFAULT 0`);
}
if (!columnExists('comments', 'user_id')) {
  db.exec(`ALTER TABLE comments ADD COLUMN user_id INTEGER REFERENCES users(id)`);
}
if (!columnExists('comments', 'is_anonymous')) {
  db.exec(`ALTER TABLE comments ADD COLUMN is_anonymous INTEGER DEFAULT 0`);
}
if (!columnExists('likes', 'user_id')) {
  db.exec(`ALTER TABLE likes ADD COLUMN user_id INTEGER REFERENCES users(id)`);
}
if (!columnExists('users', 'is_banned')) {
  db.exec(`ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0`);
}
if (!columnExists('users', 'banned_until')) {
  db.exec(`ALTER TABLE users ADD COLUMN banned_until TEXT`);
}
if (!columnExists('users', 'ban_reason')) {
  db.exec(`ALTER TABLE users ADD COLUMN ban_reason TEXT DEFAULT ''`);
}
if (!columnExists('appeals', 'appeal_type')) {
  db.exec(`ALTER TABLE appeals ADD COLUMN appeal_type TEXT DEFAULT 'name_dispute'`);
}
if (!columnExists('banned_ips', 'banned_until')) {
  db.exec(`ALTER TABLE banned_ips ADD COLUMN banned_until TEXT`);
}

// Phase 5 migrations
if (!columnExists('posts', 'category')) {
  db.exec(`ALTER TABLE posts ADD COLUMN category TEXT DEFAULT 'other'`);
}
if (!columnExists('comments', 'parent_comment_id')) {
  db.exec(`ALTER TABLE comments ADD COLUMN parent_comment_id INTEGER DEFAULT NULL`);
}
if (!columnExists('comments', 'like_count')) {
  db.exec(`ALTER TABLE comments ADD COLUMN like_count INTEGER DEFAULT 0`);
}
if (!columnExists('posts', 'repost_of')) {
  db.exec(`ALTER TABLE posts ADD COLUMN repost_of INTEGER DEFAULT NULL`);
}
if (!columnExists('posts', 'repost_count')) {
  db.exec(`ALTER TABLE posts ADD COLUMN repost_count INTEGER DEFAULT 0`);
}
if (!columnExists('posts', 'scheduled_delete_at')) {
  db.exec(`ALTER TABLE posts ADD COLUMN scheduled_delete_at TEXT`);
}
if (!columnExists('posts', 'onboarding')) {
  db.exec(`ALTER TABLE posts ADD COLUMN onboarding INTEGER DEFAULT 0`);
}
if (!columnExists('users', 'role')) {
  db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`);
}
if (!columnExists('users', 'agreed_terms_at')) {
  db.exec(`ALTER TABLE users ADD COLUMN agreed_terms_at TEXT`);
}
if (!columnExists('users', 'agreed_terms_version')) {
  db.exec(`ALTER TABLE users ADD COLUMN agreed_terms_version TEXT DEFAULT ''`);
}
if (!columnExists('users', 'data_consent_at')) {
  db.exec(`ALTER TABLE users ADD COLUMN data_consent_at TEXT`);
}
if (!columnExists('users', 'is_external')) {
  db.exec(`ALTER TABLE users ADD COLUMN is_external INTEGER DEFAULT 0`);
}
if (!columnExists('users', 'school')) {
  db.exec(`ALTER TABLE users ADD COLUMN school TEXT DEFAULT ''`);
}
// bio 列（多处代码已引用，补上缺失的迁移）
if (!columnExists('users', 'bio')) {
  db.exec(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`);
}
if (!columnExists('posts', 'external_hidden')) {
  db.exec(`ALTER TABLE posts ADD COLUMN external_hidden INTEGER DEFAULT 0`);
}

// Report system v2: per-user dedup + comment reports
if (!columnExists('reports', 'user_id')) {
  db.exec(`ALTER TABLE reports ADD COLUMN user_id INTEGER REFERENCES users(id)`);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_post_user ON reports(post_id, user_id)`);

if (!columnExists('comments', 'report_count')) {
  db.exec(`ALTER TABLE comments ADD COLUMN report_count INTEGER DEFAULT 0`);
}
if (!columnExists('comments', 'hidden')) {
  db.exec(`ALTER TABLE comments ADD COLUMN hidden INTEGER DEFAULT 0`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS comment_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    reason TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(comment_id, user_id),
    FOREIGN KEY (comment_id) REFERENCES comments(id)
  );
`);

// Comment likes table (more flexible than like_count column)
db.exec(`
  CREATE TABLE IF NOT EXISTS comment_likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    user_id INTEGER,
    ip TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(comment_id, user_id),
    FOREIGN KEY (comment_id) REFERENCES comments(id)
  );
`);

// Verification system
if (!columnExists('users', 'verified_label')) {
  db.exec(`ALTER TABLE users ADD COLUMN verified_label TEXT DEFAULT ''`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS verification_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    org_type TEXT NOT NULL,
    org_name TEXT NOT NULL,
    role TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Follow system
if (!columnExists('users', 'follower_count')) {
  db.exec(`ALTER TABLE users ADD COLUMN follower_count INTEGER DEFAULT 0`);
}
if (!columnExists('users', 'following_count')) {
  db.exec(`ALTER TABLE users ADD COLUMN following_count INTEGER DEFAULT 0`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    follower_id INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(follower_id, following_id),
    FOREIGN KEY (follower_id) REFERENCES users(id),
    FOREIGN KEY (following_id) REFERENCES users(id)
  );
`);

// [2026-08-03] 任务4: profile privacy
if (!columnExists('users', 'profile_public')) {
  db.exec(`ALTER TABLE users ADD COLUMN profile_public INTEGER DEFAULT 1`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    content TEXT NOT NULL,
    ip TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    reply TEXT DEFAULT '',
    replied_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// [2026-08-03] 留言回复: add reply columns to existing messages table
if (!columnExists('messages', 'reply')) {
  db.exec(`ALTER TABLE messages ADD COLUMN reply TEXT DEFAULT ''`);
}
if (!columnExists('messages', 'replied_at')) {
  db.exec(`ALTER TABLE messages ADD COLUMN replied_at TEXT`);
}

// [2026-08-04] 任务4: multi-image support
if (!columnExists('posts', 'media_urls')) {
  db.exec(`ALTER TABLE posts ADD COLUMN media_urls TEXT`);
}

// [2026-08-07] Boards feature
db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    icon TEXT NOT NULL DEFAULT '📌',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

if (!columnExists('posts', 'board_id')) {
  db.exec(`ALTER TABLE posts ADD COLUMN board_id INTEGER`);
}

if (!columnExists('posts', 'pin_expires_at')) {
  db.exec(`ALTER TABLE posts ADD COLUMN pin_expires_at TEXT`);
}

// [2026-08-31] Word 文档附件（防宏病毒，仅 .docx）
if (!columnExists('posts', 'docx_url')) {
  db.exec(`ALTER TABLE posts ADD COLUMN docx_url TEXT`);
}
if (!columnExists('posts', 'docx_name')) {
  db.exec(`ALTER TABLE posts ADD COLUMN docx_name TEXT`);
}

// [白标化 B1] 板块初始化读 config：读 registry.boards（对象数组，兼容字符串）→ INSERT OR IGNORE（只增不删）
// 合并原 seedBoards（仅空库播种）+ insertBoardIfMissing（增量补齐）为一个循环；空数组则跳过 seeding
const insertBoardIfMissing = db.prepare('INSERT OR IGNORE INTO boards (name, icon, description) VALUES (?, ?, ?)');
const configBoards = siteConfig.registry && siteConfig.registry.boards;
if (Array.isArray(configBoards)) {
  for (const b of configBoards) {
    if (typeof b === 'string') {
      insertBoardIfMissing.run(b, '📌', ''); // 字符串 → 默认 emoji + 空描述
    } else if (b && typeof b === 'object' && b.name) {
      insertBoardIfMissing.run(b.name, b.icon || '📌', b.description || '');
    }
  }
}
console.log('[boards] Ensure boards exist from config (' + (Array.isArray(configBoards) ? configBoards.length : 0) + ' boards)');

// [2026-08-07] 点赞通知关联帖子
if (!columnExists('notifications', 'post_id')) {
  db.exec(`ALTER TABLE notifications ADD COLUMN post_id INTEGER`);
}

// [2026-08-03] 任务5: poll/voting tables
db.exec(`
  CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL UNIQUE,
    question TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id)
  );

  CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    vote_count INTEGER DEFAULT 0,
    FOREIGN KEY (poll_id) REFERENCES polls(id)
  );

  CREATE TABLE IF NOT EXISTS poll_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    option_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(poll_id, user_id),
    FOREIGN KEY (poll_id) REFERENCES polls(id),
    FOREIGN KEY (option_id) REFERENCES poll_options(id)
  );
`);

// [2026-08-09] Direct Messages (user-to-user)
db.exec(`
  CREATE TABLE IF NOT EXISTS dm_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (sender_id) REFERENCES users(id),
    FOREIGN KEY (receiver_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages (sender_id, receiver_id);
`);

// [2026-08-16] 积分等级系统：users 表新字段
if (!columnExists('users', 'points')) {
  db.exec(`ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0`);
}
if (!columnExists('users', 'level')) {
  db.exec(`ALTER TABLE users ADD COLUMN level INTEGER DEFAULT 1`);
}
if (!columnExists('users', 'nickname_color')) {
  db.exec(`ALTER TABLE users ADD COLUMN nickname_color TEXT DEFAULT ''`);
}
if (!columnExists('users', 'font_size')) {
  db.exec(`ALTER TABLE users ADD COLUMN font_size TEXT DEFAULT 'medium'`);
}
if (!columnExists('users', 'last_login_date')) {
  db.exec(`ALTER TABLE users ADD COLUMN last_login_date TEXT`);
}
if (!columnExists('users', 'streak_days')) {
  db.exec(`ALTER TABLE users ADD COLUMN streak_days INTEGER DEFAULT 0`);
}
if (!columnExists('users', 'weekly_pin_used')) {
  db.exec(`ALTER TABLE users ADD COLUMN weekly_pin_used INTEGER DEFAULT 0`);
}
if (!columnExists('users', 'weekly_pin_week')) {
  db.exec(`ALTER TABLE users ADD COLUMN weekly_pin_week TEXT`);
}
// 每日置顶次数（Lv.4/5 每天 1 次）
if (!columnExists('users', 'daily_pin_used')) {
  db.exec(`ALTER TABLE users ADD COLUMN daily_pin_used INTEGER DEFAULT 0`);
}
if (!columnExists('users', 'daily_pin_date')) {
  db.exec(`ALTER TABLE users ADD COLUMN daily_pin_date TEXT`);
}

// 积分明细表（可审计）
db.exec(`
  CREATE TABLE IF NOT EXISTS point_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    target_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_point_logs_user ON point_logs (user_id);
  CREATE INDEX IF NOT EXISTS idx_point_logs_reason_date ON point_logs (reason, created_at);
`);

module.exports = db;
