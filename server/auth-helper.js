// Shared auth helpers: Bearer header OR httpOnly cookie token extraction
const jwt = require('jsonwebtoken');

// ===== JWT 密钥（安全加固 2026-09-13）=====
// 生产必须通过环境变量 JWT_SECRET 提供；缺省时拒绝启动，绝不用可猜的硬编码密钥。
// 开发环境（非 production）才回退到随机临时密钥（每次重启失效，仅供本地调试）。
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[auth] 致命：生产环境必须设置 JWT_SECRET（未设置等于允许任何人伪造登录令牌）');
    process.exit(1);
  }
  JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
  console.warn('[auth] ⚠️ 未设置 JWT_SECRET，已生成临时密钥（仅限开发；生产请设 JWT_SECRET）');
}
const TOKEN_COOKIE = 'pw_token';

function getTokenFromReq(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  const cookie = req.headers.cookie;
  if (cookie) {
    const found = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(TOKEN_COOKIE + '='));
    if (found) return decodeURIComponent(found.slice(TOKEN_COOKIE.length + 1));
  }
  return null;
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: 7 * 24 * 3600 * 1000
  };
}

// Login-gate helper: return decoded JWT payload if request carries a valid token, else null (never throws)
function getUserFromReq(req) {
  const token = getTokenFromReq(req);
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

module.exports = { JWT_SECRET, TOKEN_COOKIE, getTokenFromReq, cookieOptions, getUserFromReq };
