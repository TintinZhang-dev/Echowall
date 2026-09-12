// ===== Phewall 积分 + 等级 + 置顶特权 核心模块 =====
// 仿 B 站经验值体系，植物系等级贴合"花圃"定位
const db = require('./db');

// 等级定义（所需积分、名称、颜色、emoji）
const LEVELS = [
  { level: 1, name: '新芽',     points: 0,    color: '#9ca3af', emoji: '🌱' },
  { level: 2, name: '青苗',     points: 50,   color: '#22c55e', emoji: '🌿' },
  { level: 3, name: '新叶',     points: 150,  color: '#84cc16', emoji: '🍃' },
  { level: 4, name: '繁花',     points: 400,  color: '#ec4899', emoji: '🌸' },
  { level: 5, name: '乔木',     points: 900,  color: '#3b82f6', emoji: '🌳' },
  { level: 6, name: '大树',     points: 2000, color: '#8b5cf6', emoji: '🌲' },
  { level: 7, name: '花圃之巅', points: 5000, color: '#f59e0b', emoji: '👑' },
];

// 每日积分上限
const DAILY_CAPS = {
  login: 2,       // 每日登录 +2
  streak: 7,      // 连续登录 +N（N≤7）
  post: 3,        // 发帖 +3（每天第1帖起算）
  comment: 5,     // 评论 +1
  liked: 10,      // 收到的赞 +1/个
  followed: 6,    // 被关注 +2/个
};

function getLevelForPoints(points) {
  let lv = 1;
  for (const l of LEVELS) {
    if (points >= l.points) lv = l.level;
  }
  return lv;
}

function getLevelInfo(level) {
  return LEVELS.find(l => l.level === level) || LEVELS[0];
}

// 下一级信息（null 表示已满级）
// [2026-08-31] 修复：pointsNeeded/remaining 改为真正还差多少（next.points - 当前积分），
// 之前返回的是本级到下一级的全段跨度，导致"还需 50 积分"永远显示 50。
function getNextLevelInfo(level, currentPoints) {
  const cur = getLevelInfo(level);
  const next = LEVELS.find(l => l.level === level + 1);
  if (!next) return null;
  const remaining = Math.max(0, (next.points || 0) - (currentPoints || 0));
  return {
    level: next.level,
    name: next.name,
    color: next.color,
    emoji: next.emoji,
    points: next.points,
    pointsNeeded: remaining,
    remaining,
    current: cur.points,
  };
}

// 置顶特权配额（由等级决定）
function pinQuotaFor(level) {
  if (level >= 6) return { durationHours: 24, period: 'weekly', max: 1 };  // Lv.6 大树 / Lv.7 花圃之巅
  if (level >= 5) return { durationHours: 3,  period: 'daily',  max: 1 };  // Lv.5 乔木
  if (level >= 4) return { durationHours: 1,  period: 'daily',  max: 1 };  // Lv.4 繁花
  return null; // 未解锁
}

// 今天（UTC）日期字符串 YYYY-MM-DD，与 point_logs.created_at 的 date() 一致
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// 周标识（匹配 SQLite strftime('%Y-%W')，周一为每周起点）
function weekStr() {
  const d = new Date();
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const jan1Day = jan1.getUTCDay(); // 0 Sun .. 6 Sat
  const daysToFirstMonday = jan1Day === 0 ? 1 : (jan1Day === 1 ? 0 : (8 - jan1Day));
  const dayOfYear = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
  let week = Math.floor((dayOfYear - daysToFirstMonday) / 7) + 1;
  if (dayOfYear < daysToFirstMonday) week = 0;
  return `${year}-${String(week).padStart(2, '0')}`;
}

// 昨天（UTC）日期字符串，用于连续登录判断
function yesterdayUTC() {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

// 加分核心函数：每日上限 + 10 秒去重 + 写入 point_logs + 重算等级
// targetId: 关联对象 id（帖子/评论/关注者）
// dedup: 'target' 按 target 去重 / 'reason' 按原因去重 / null 不去重
function award(userId, amount, reason, targetId = null, dedup = null) {
  if (!userId || amount <= 0) return { awarded: 0 };
  const cap = DAILY_CAPS[reason];
  if (!cap) return { awarded: 0 };

  const today = todayUTC();

  // 每日上限
  const todaySum = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM point_logs WHERE user_id = ? AND reason = ? AND date(created_at) = ?"
  ).get(userId, reason, today).s;
  if (todaySum >= cap) return { awarded: 0, capped: true };

  let amt = Math.min(amount, cap - todaySum);
  if (amt <= 0) return { awarded: 0, capped: true };

  // 10 秒去重
  if (dedup === 'target') {
    const recent = db.prepare(
      "SELECT id FROM point_logs WHERE user_id = ? AND reason = ? AND target_id IS ? AND created_at > datetime('now', '-10 seconds') LIMIT 1"
    ).get(userId, reason, targetId);
    if (recent) return { awarded: 0, deduped: true };
  } else if (dedup === 'reason') {
    const recent = db.prepare(
      "SELECT id FROM point_logs WHERE user_id = ? AND reason = ? AND created_at > datetime('now', '-10 seconds') LIMIT 1"
    ).get(userId, reason);
    if (recent) return { awarded: 0, deduped: true };
  }

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO point_logs (user_id, amount, reason, target_id) VALUES (?, ?, ?, ?)')
      .run(userId, amt, reason, targetId);
    db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(amt, userId);
  });
  tx();

  const u = db.prepare('SELECT points FROM users WHERE id = ?').get(userId);
  const level = getLevelForPoints(u.points);
  db.prepare('UPDATE users SET level = ? WHERE id = ?').run(level, userId);

  return { awarded: amt, points: u.points, level };
}

// 当前积分概览（主页 + 设置页用）
function overview(userId) {
  const u = db.prepare('SELECT points, level, streak_days FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  const info = getLevelInfo(u.level || 1);
  const next = getNextLevelInfo(u.level || 1, u.points || 0);
  const logs = db.prepare(
    'SELECT id, amount, reason, target_id, created_at FROM point_logs WHERE user_id = ? ORDER BY id DESC LIMIT 20'
  ).all(userId);

  // 进度条：距下一级积分百分比
  let progressPct = 100;
  if (next) {
    const cur = info.points;
    const span = next.points - cur;
    progressPct = span > 0 ? Math.min(100, Math.round((u.points - cur) / span * 100)) : 100;
  }

  return {
    points: u.points,
    level: u.level || 1,
    level_name: info.name,
    level_color: info.color,
    level_emoji: info.emoji,
    streak_days: u.streak_days || 0,
    next_level: next,
    progress_pct: progressPct,
    logs,
  };
}

// [2026-08-31] 撤销积分：删帖/删评论时调用，把之前奖励的积分扣回并记负账
// （否则实际积分虚高，明细对不上——用户反馈 #57）
function revoke(userId, reason, targetId) {
  if (!userId || !targetId) return { revoked: 0 };
  const rows = db.prepare(
    'SELECT id, amount FROM point_logs WHERE user_id = ? AND reason = ? AND target_id = ?'
  ).all(userId, reason, targetId);
  if (!rows.length) return { revoked: 0 };
  let total = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (r.amount > 0) {
        db.prepare('INSERT INTO point_logs (user_id, amount, reason, target_id) VALUES (?, ?, ?, ?)')
          .run(userId, -r.amount, reason, targetId);
        total += r.amount;
      }
    }
    if (total > 0) {
      db.prepare('UPDATE users SET points = MAX(0, points - ?) WHERE id = ?').run(total, userId);
    }
  });
  tx();
  if (total > 0) {
    const u = db.prepare('SELECT points FROM users WHERE id = ?').get(userId);
    const level = getLevelForPoints(u.points);
    db.prepare('UPDATE users SET level = ? WHERE id = ?').run(level, userId);
  }
  return { revoked: total };
}

// 给作者对象补充等级展示字段（昵称颜色 + 等级名/颜色/emoji）
function authorMeta(u) {
  if (!u) return null;
  const info = getLevelInfo(u.level || 1);
  return {
    ...u,
    level: u.level || 1,
    points: u.points || 0,
    nickname_color: u.nickname_color || '',
    level_name: info.name,
    level_color: info.color,
    level_emoji: info.emoji,
  };
}

module.exports = {
  LEVELS,
  DAILY_CAPS,
  getLevelForPoints,
  getLevelInfo,
  getNextLevelInfo,
  pinQuotaFor,
  todayUTC,
  yesterdayUTC,
  weekStr,
  award,
  revoke,
  overview,
  authorMeta,
};
