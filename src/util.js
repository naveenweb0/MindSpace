'use strict';
/* Shared helpers for The Pause Studio backend. */

const crypto = require('crypto');

/* ----------------------------- ids & tokens ----------------------------- */

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function randomString(n, alphabet = REF_ALPHABET) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[b[i] % alphabet.length];
  return s;
}
function bookingRef() { return 'TP-' + randomString(6); }
function membershipRef() { return 'TPM-' + randomString(6); }
function randomToken(n = 32) { return crypto.randomBytes(n).toString('hex'); }

/* ----------------------------- passwords ----------------------------- */

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return salt + ':' + h;
}
function verifyPassword(pw, stored) {
  try {
    if (!stored || typeof stored !== 'string') return false;
    const parts = stored.split(':');
    if (parts.length !== 2) return false;
    const [salt, h] = parts;
    if (!salt || !h) return false;
    const bufA = Buffer.from(h, 'hex');
    const bufB = Buffer.from(crypto.scryptSync(String(pw), salt, 64).toString('hex'), 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (err) {
    return false;
  }
}

/* ----------------------------- dates / times ----------------------------- */

const pad = (n) => String(n).padStart(2, '0');
function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayStr() { return dateStr(new Date()); }
function parseDate(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); }
function nowIso() { return new Date().toISOString(); }

function minutesOfDay(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; }
function addMinutesToTime(t, mins) {
  const total = minutesOfDay(t) + mins;
  return pad(Math.floor(total / 60) % 24) + ':' + pad(total % 60);
}
function isValidTime(t) { return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(t || '')); }

function fmtINR(n) { return '₹' + Number(n).toLocaleString('en-IN'); }
function fmtDate(s) {
  if (!s) return '—';
  const d = parseDate(s);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateShort(s) {
  if (!s) return '—';
  const d = parseDate(s);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
function fmtTime(t) {
  if (!t) return '—';
  const [h, m] = String(t).split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return hh + ':' + pad(m) + ' ' + ap;
}

/* ----------------------------- validation ----------------------------- */

function sanitize(v, max = 2000) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }
function validPhone(p) { return /^[0-9+\-\s()]{7,15}$/.test(String(p || '').trim()); }

/* ----------------------------- http ----------------------------- */

function ok(res, data) { res.json({ ok: true, ...(data || {}) }); }
function fail(res, status, code, message, extra) {
  res.status(status).json({ ok: false, error: code, message, ...(extra || {}) });
}

/* ----------------------------- settings ----------------------------- */

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM studio_settings').all();
  const s = {};
  for (const r of rows) {
    try { s[r.key] = JSON.parse(r.value); } catch (e) { s[r.key] = r.value; }
  }
  return s;
}
function getSetting(db, key, dflt) {
  const row = db.prepare('SELECT value FROM studio_settings WHERE key = ?').get(key);
  if (!row) return dflt;
  try { return JSON.parse(row.value); } catch (e) { return row.value; }
}
function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO studio_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, JSON.stringify(value));
}

module.exports = {
  randomString, bookingRef, membershipRef, randomToken,
  hashPassword, verifyPassword,
  dateStr, todayStr, parseDate, addDays, nowIso, pad,
  minutesOfDay, addMinutesToTime, isValidTime,
  fmtINR, fmtDate, fmtDateShort, fmtTime,
  sanitize, validEmail, validPhone,
  ok, fail, getSettings, getSetting, setSetting,
};
