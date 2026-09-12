// Shared auth helpers: Bearer header OR httpOnly cookie token extraction
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'echowall-jwt-2026-change-me';
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
