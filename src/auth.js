'use strict';
/* Admin authentication: session cookies + header token fallback + role-based access. */

const u = require('./util');

const SESSION_DAYS = 7;

function createSession(db, userId) {
  const token = u.randomToken(32);
  const created = u.nowIso();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO admin_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, created, expires);
  return { token, expires };
}

function getSessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.token, s.expires_at, u.id, u.name, u.email, u.role
     FROM admin_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (row.expires_at <= u.nowIso()) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
}

const COOKIE_NAME = 'tps_admin';

function setCookie(res, token, expires) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, sameSite: 'lax', secure: false,
    expires: new Date(expires), path: '/',
  });
}
function clearCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function extractToken(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const authHeader = req.headers && req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.headers && req.headers['x-admin-token']) return req.headers['x-admin-token'];
  return null;
}

/** Middleware: require a logged-in admin. */
function adminOnly(req, res, next) {
  const token = extractToken(req);
  const user = getSessionUser(req.db, token);
  if (!user) return u.fail(res, 401, 'AUTH_REQUIRED', 'Please sign in as an admin.');
  req.admin = user;
  req.adminToken = token;
  next();
}

/* In-memory rate limit tracking for failed login attempts. */
const failedAttempts = new Map();
function isRateLimited(ip) {
  const key = ip || 'unknown';
  const win = failedAttempts.get(key);
  if (!win) return false;
  if (Date.now() > win.reset) { failedAttempts.delete(key); return false; }
  return win.count >= 15;
}
function recordFailedAttempt(ip) {
  const key = ip || 'unknown';
  const win = failedAttempts.get(key) || { count: 0, reset: Date.now() + 15 * 60 * 1000 };
  if (Date.now() > win.reset) { win.count = 0; win.reset = Date.now() + 15 * 60 * 1000; }
  win.count++;
  failedAttempts.set(key, win);
}
function resetRateLimit(ip) {
  const key = ip || 'unknown';
  failedAttempts.delete(key);
}

module.exports = {
  createSession, getSessionUser, destroySession, adminOnly,
  setCookie, clearCookie, COOKIE_NAME, extractToken,
  isRateLimited, recordFailedAttempt, resetRateLimit,
};
