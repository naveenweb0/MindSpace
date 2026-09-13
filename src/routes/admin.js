'use strict';
/* Admin API — protected by session auth. */

const express = require('express');
const u = require('../util');
const auth = require('../auth');
const slots = require('../slots');
const booking = require('../booking');
const notify = require('../notify');

module.exports = function adminRoutes(db) {
  const r = express.Router();

  /* ----------------------------- auth ----------------------------- */

  r.post('/login', (req, res) => {
    try {
      const { email, password } = req.body || {};
      const ip = req.ip || req.socket.remoteAddress;
      if (auth.isRateLimited(ip)) {
        return u.fail(res, 429, 'RATE_LIMITED', 'Too many failed attempts. Please try again in 15 minutes.');
      }
      const cleanEmail = String(email || '').trim().toLowerCase();
      
      let user = db.prepare(`SELECT * FROM users WHERE (LOWER(email) = ? OR (LOWER(email) = 'admin@thepausestudio.in' AND ? = 'admin@mindspacestudio.in')) AND role = 'admin'`).get(cleanEmail, cleanEmail);
      
      // Auto-create / heal admin if needed
      if (!user && (cleanEmail === 'admin@mindspacestudio.in' || cleanEmail === 'admin@thepausestudio.in')) {
        const ins = db.prepare("INSERT OR REPLACE INTO users (id, name, email, phone, password_hash, role) VALUES (1, ?, ?, ?, ?, 'admin')");
        ins.run('Studio Admin', 'admin@mindspacestudio.in', '', u.hashPassword('pause1234'));
        user = db.prepare(`SELECT * FROM users WHERE LOWER(email) = 'admin@mindspacestudio.in' AND role = 'admin'`).get();
      }
      
      if (!user || !u.verifyPassword(password, user.password_hash)) {
        auth.recordFailedAttempt(ip);
        return u.fail(res, 401, 'BAD_CREDENTIALS', 'Incorrect email or password.');
      }
      auth.resetRateLimit(ip);
      const s = auth.createSession(db, user.id);
      try { auth.setCookie(res, s.token, s.expires); } catch (_) {}
      u.ok(res, {
        token: s.token,
        expires: s.expires,
        admin: { id: user.id, name: user.name, email: user.email },
      });
    } catch (loginErr) {
      console.error('Login route error:', loginErr);
      return u.fail(res, 500, 'LOGIN_ERROR', 'Login error: ' + loginErr.message);
    }
  });

  r.post('/logout', (req, res) => {
    const token = auth.extractToken(req);
    auth.destroySession(db, token);
    auth.clearCookie(res);
    u.ok(res, {});
  });

  r.get('/me', auth.adminOnly, (req, res) => {
    u.ok(res, { admin: { id: req.admin.id, name: req.admin.name, email: req.admin.email } });
  });

  /* Everything below requires a logged-in admin. */
  r.use(auth.adminOnly);

  /* ----------------------------- dashboard ----------------------------- */

  r.get('/dashboard', (req, res) => {
    const today = u.todayStr();
    const weekStart = u.addDays(today, -7);

    const bookingsToday = db.prepare(
      `SELECT COUNT(*) AS n FROM bookings WHERE date = ? AND booking_status != 'cancelled'`
    ).get(today).n;
    const revenueToday = db.prepare(
      `SELECT COALESCE(SUM(total_amount),0) AS s FROM bookings WHERE date = ? AND payment_status = 'paid'`
    ).get(today).s;
    const totalBookings = db.prepare(
      `SELECT COUNT(*) AS n FROM bookings WHERE booking_status != 'cancelled'`
    ).get().n;
    const totalRevenue = db.prepare(
      `SELECT COALESCE(SUM(total_amount),0) AS s FROM bookings WHERE payment_status = 'paid'`
    ).get().s;
    const sessionsToday = db.prepare(
      `SELECT COUNT(DISTINCT date || start_time) AS n FROM bookings WHERE date = ? AND booking_status != 'cancelled'`
    ).get(today).n;
    const guestsToday = db.prepare(
      `SELECT COALESCE(SUM(number_of_guests),0) AS n FROM bookings WHERE date = ? AND booking_status != 'cancelled'`
    ).get(today).n;
    const capacity = Number(u.getSetting(db, 'slot_capacity', 8));
    const capacityPct = sessionsToday ? Math.min(100, Math.round((guestsToday / (sessionsToday * capacity)) * 100)) : 0;

    const pending = db.prepare(
      `SELECT COUNT(*) AS n FROM bookings WHERE payment_status='unpaid' AND booking_status='pending' AND expires_at > ?`
    ).get(u.nowIso()).n;
    const upcoming = db.prepare(
      `SELECT COUNT(*) AS n FROM bookings WHERE date >= ? AND booking_status IN ('pending','confirmed')`
    ).get(today).n;
    const activeMembers = db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE status='active'`).get().n;
    const newMessages = db.prepare(`SELECT COUNT(*) AS n FROM contact_messages`).get().n;

    const latest = db.prepare(`
      SELECT b.*, a.name AS activity_name FROM bookings b JOIN activities a ON a.id = b.activity_id
      ORDER BY b.created_at DESC LIMIT 10`).all();

    u.ok(res, {
      stats: { bookingsToday, revenueToday, totalBookings, totalRevenue, sessionsToday, capacityPct, pending, upcoming, activeMembers, newMessages },
      latest,
    });
  });

  /* ----------------------------- bookings ----------------------------- */

  r.get('/bookings', (req, res) => {
    const q = req.query;
    const where = [];
    const params = [];
    if (q.range === 'today') { where.push('b.date = ?'); params.push(u.todayStr()); }
    else if (q.range === 'tomorrow') { where.push('b.date = ?'); params.push(u.addDays(u.todayStr(), 1)); }
    else if (q.range === 'week') { where.push('b.date >= ? AND b.date <= ?'); params.push(u.todayStr(), u.addDays(u.todayStr(), 7)); }
    else if (q.range === 'custom' && q.from) {
      where.push('b.date >= ?'); params.push(u.sanitize(q.from, 10));
      if (q.to) { where.push('b.date <= ?'); params.push(u.sanitize(q.to, 10)); }
    }
    if (q.activity) { where.push('b.activity_id = ?'); params.push(Number(q.activity)); }
    if (q.booking_status) { where.push('b.booking_status = ?'); params.push(u.sanitize(q.booking_status, 20)); }
    if (q.payment_status) { where.push('b.payment_status = ?'); params.push(u.sanitize(q.payment_status, 20)); }
    if (q.q) { where.push('(b.booking_reference LIKE ? OR b.customer_name LIKE ? OR b.customer_phone LIKE ?)'); const like = '%' + u.sanitize(q.q, 40) + '%'; params.push(like, like, like); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const rows = db.prepare(`
      SELECT b.*, a.name AS activity_name, a.image AS activity_image
      FROM bookings b JOIN activities a ON a.id = b.activity_id
      ${whereSql} ORDER BY b.date DESC, b.start_time ASC LIMIT 400`).all(...params);
    const revenue = rows.filter((x) => x.payment_status === 'paid').reduce((s, x) => s + x.total_amount, 0);

    const statuses = db.prepare('SELECT DISTINCT booking_status AS v FROM bookings').all().map((x) => x.v);
    const payStatuses = db.prepare('SELECT DISTINCT payment_status AS v FROM bookings').all().map((x) => x.v);
    u.ok(res, { bookings: rows, revenue, statuses, payStatuses });
  });

  r.get('/bookings/:id', (req, res) => {
    const b = db.prepare(`
      SELECT b.*, a.name AS activity_name, a.image AS activity_image
      FROM bookings b JOIN activities a ON a.id = b.activity_id WHERE b.id = ?`).get(Number(req.params.id));
    if (!b) return u.fail(res, 404, 'NOT_FOUND', 'Booking not found.');
    const pays = db.prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at DESC').all(b.id);
    u.ok(res, { booking: b, payments: pays });
  });

  r.patch('/bookings/:id', (req, res) => {
    const { booking_status } = req.body || {};
    const allowed = ['confirmed', 'attended', 'no_show', 'cancelled', 'pending'];
    if (!allowed.includes(booking_status)) return u.fail(res, 400, 'BAD_STATUS', 'Invalid status.');
    db.prepare(`UPDATE bookings SET booking_status=?, updated_at=? WHERE id=?`).run(booking_status, u.nowIso(), Number(req.params.id));
    u.ok(res, {});
  });

  r.post('/bookings/:id/cancel', (req, res) => {
    try {
      const b = db.prepare('SELECT booking_reference FROM bookings WHERE id = ?').get(Number(req.params.id));
      if (!b) return u.fail(res, 404, 'NOT_FOUND', 'Booking not found.');
      const result = booking.cancelBooking(db, b.booking_reference, 'admin');
      u.ok(res, { booking: result.booking, refunded: !!result.refunded });
    } catch (e) { u.fail(res, 400, 'CANCEL_FAILED', e.message); }
  });

  r.post('/bookings/:id/refund', (req, res) => {
    try {
      const b = db.prepare('SELECT booking_reference FROM bookings WHERE id = ?').get(Number(req.params.id));
      if (!b) return u.fail(res, 404, 'NOT_FOUND', 'Booking not found.');
      const rb = booking.refundBooking(db, b.booking_reference);
      u.ok(res, { booking: rb });
    } catch (e) { u.fail(res, 400, 'REFUND_FAILED', e.message); }
  });

  r.post('/bookings/:id/reschedule', (req, res) => {
    try {
      const b = db.prepare('SELECT booking_reference FROM bookings WHERE id = ?').get(Number(req.params.id));
      if (!b) return u.fail(res, 404, 'NOT_FOUND', 'Booking not found.');
      const settings = u.getSettings(db);
      const rb = booking.rescheduleBooking(db, settings, b.booking_reference, req.body.date, req.body.start_time);
      u.ok(res, { booking: rb.booking });
    } catch (e) { u.fail(res, 400, 'RESCHEDULE_FAILED', e.message); }
  });

  /* ----------------------------- calendar / slots ----------------------------- */

  r.get('/calendar', (req, res) => {
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const settings = u.getSettings(db);
    const days = slots.calendarForMonth(db, year, month, settings).map((d) => {
      const av = slots.availabilityForDate(db, d.date, settings);
      const bookings = db.prepare(`
        SELECT b.*, a.name AS activity_name FROM bookings b JOIN activities a ON a.id = b.activity_id
        WHERE b.date = ? ORDER BY b.start_time`).all(d.date);
      return { ...d, bookings, slots: av.slots };
    });
    const blockedDates = db.prepare('SELECT * FROM blocked_dates WHERE date LIKE ?').all(`${year}-${u.pad(month)}%`);
    const blockedSlots = db.prepare('SELECT * FROM blocked_slots WHERE date LIKE ?').all(`${year}-${u.pad(month)}%`);
    u.ok(res, { days, blockedDates, blockedSlots, year, month });
  });

  r.post('/slots', (req, res) => {
    const { date, start_time, capacity, note } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(u.sanitize(date, 10)) || !u.isValidTime(start_time)) return u.fail(res, 400, 'BAD_SLOT', 'Invalid slot.');
    db.prepare(`
      INSERT INTO time_slots (date, start_time, capacity, note) VALUES (?, ?, ?, ?)
      ON CONFLICT(date, start_time) DO UPDATE SET capacity=excluded.capacity, note=excluded.note`)
      .run(u.sanitize(date, 10), start_time, capacity != null ? Number(capacity) : null, u.sanitize(note, 200));
    u.ok(res, {});
  });

  r.delete('/slots/:id', (req, res) => {
    db.prepare('DELETE FROM time_slots WHERE id = ?').run(Number(req.params.id));
    u.ok(res, {});
  });

  r.post('/blocked-dates', (req, res) => {
    const date = u.sanitize((req.body || {}).date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return u.fail(res, 400, 'BAD_DATE', 'Invalid date.');
    db.prepare('INSERT OR IGNORE INTO blocked_dates (date, reason) VALUES (?, ?)').run(date, u.sanitize((req.body || {}).reason, 200));
    u.ok(res, {});
  });

  r.delete('/blocked-dates/:date', (req, res) => {
    db.prepare('DELETE FROM blocked_dates WHERE date = ?').run(u.sanitize(req.params.date, 10));
    u.ok(res, {});
  });

  r.post('/blocked-slots', (req, res) => {
    const { date, start_time, reason } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(u.sanitize(date, 10)) || !u.isValidTime(start_time)) return u.fail(res, 400, 'BAD_SLOT', 'Invalid slot.');
    db.prepare('INSERT OR IGNORE INTO blocked_slots (date, start_time, reason) VALUES (?, ?, ?)')
      .run(u.sanitize(date, 10), start_time, u.sanitize(reason, 200));
    u.ok(res, {});
  });

  r.delete('/blocked-slots/:id', (req, res) => {
    db.prepare('DELETE FROM blocked_slots WHERE id = ?').run(Number(req.params.id));
    u.ok(res, {});
  });

  /* ----------------------------- activities ----------------------------- */

  r.get('/activities', (req, res) => {
    const acts = db.prepare('SELECT * FROM activities ORDER BY sort_order').all().map((a) => ({
      ...a,
      durations: db.prepare('SELECT minutes, price FROM activity_durations WHERE activity_id = ? ORDER BY minutes').all(a.id),
    }));
    u.ok(res, { activities: acts });
  });

  r.post('/activities', (req, res) => {
    const a = req.body || {};
    const slug = u.sanitize(a.slug || String(a.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), 40);
    if (!a.name || !slug) return u.fail(res, 400, 'BAD_ACTIVITY', 'Name is required.');
    const r = db.prepare(`
      INSERT INTO activities (slug, name, tagline, description, image, max_capacity, active, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(slug, u.sanitize(a.name, 80), u.sanitize(a.tagline, 200), u.sanitize(a.description, 500),
        u.sanitize(a.image, 200) || '/img/activity-painting.jpg', Number(a.max_capacity) || 8, a.active ? 1 : 0, Number(a.sort_order) || 0);
    for (const d of a.durations || []) {
      db.prepare('INSERT INTO activity_durations (activity_id, minutes, price) VALUES (?, ?, ?)')
        .run(r.lastInsertRowid, Number(d.minutes), Number(d.price));
    }
    u.ok(res, { id: r.lastInsertRowid });
  });

  r.put('/activities/:id', (req, res) => {
    const a = req.body || {};
    db.prepare(`
      UPDATE activities SET name=?, tagline=?, description=?, image=?, max_capacity=?, active=?, sort_order=?
      WHERE id=?`)
      .run(u.sanitize(a.name, 80), u.sanitize(a.tagline, 200), u.sanitize(a.description, 500),
        u.sanitize(a.image, 200), Number(a.max_capacity) || 8, a.active ? 1 : 0, Number(a.sort_order) || 0, Number(req.params.id));
    if (Array.isArray(a.durations)) {
      db.prepare('DELETE FROM activity_durations WHERE activity_id = ?').run(Number(req.params.id));
      for (const d of a.durations) {
        db.prepare('INSERT INTO activity_durations (activity_id, minutes, price) VALUES (?, ?, ?)')
          .run(Number(req.params.id), Number(d.minutes), Number(d.price));
      }
    }
    u.ok(res, {});
  });

  r.delete('/activities/:id', (req, res) => {
    db.prepare('DELETE FROM activities WHERE id = ?').run(Number(req.params.id));
    u.ok(res, {});
  });

  /* ----------------------------- settings ----------------------------- */

  r.get('/settings', (req, res) => {
    const settings = u.getSettings(db);
    const hours = db.prepare('SELECT * FROM opening_hours ORDER BY day_of_week').all();
    u.ok(res, { settings, opening_hours: hours });
  });

  r.put('/settings', (req, res) => {
    const body = req.body || {};
    const allowedKeys = ['studio_name','tagline','phone','whatsapp','email','address_line1','address_line2','city',
      'maps_url','instagram','slot_interval','slot_capacity','min_advance_hours','max_lead_days',
      'cancellation_policy','children_policy','private_sessions'];
    for (const k of allowedKeys) {
      if (k in body) u.setSetting(db, k, typeof body[k] === 'string' ? u.sanitize(body[k], 1000) : body[k]);
    }
    if (Array.isArray(body.opening_hours)) {
      const up = db.prepare('UPDATE opening_hours SET open_time=?, close_time=?, is_closed=? WHERE day_of_week=?');
      for (const h of body.opening_hours) {
        up.run(h.is_closed ? h.open_time : u.sanitize(h.open_time, 5), h.is_closed ? h.close_time : u.sanitize(h.close_time, 5),
          h.is_closed ? 1 : 0, Number(h.day_of_week));
      }
    }
    u.ok(res, {});
  });

  /* ----------------------------- memberships ----------------------------- */

  r.get('/plans', (req, res) => {
    const plans = db.prepare('SELECT * FROM membership_plans ORDER BY sort_order').all()
      .map((p) => ({ ...p, benefits: JSON.parse(p.benefits || '[]') }));
    u.ok(res, { plans });
  });

  r.post('/plans', (req, res) => {
    const p = req.body || {};
    if (!p.name || !Number(p.price)) return u.fail(res, 400, 'BAD_PLAN', 'Name and price are required.');
    const r = db.prepare(`
      INSERT INTO membership_plans (slug, name, tagline, price, interval_days, sessions_included, benefits, active, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(u.sanitize(p.slug || String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'), 40), u.sanitize(p.name, 60),
        u.sanitize(p.tagline, 200), Number(p.price), Number(p.interval_days) || 30,
        p.sessions_included ? Number(p.sessions_included) : null, JSON.stringify(p.benefits || []),
        p.active ? 1 : 0, Number(p.sort_order) || 0);
    u.ok(res, { id: r.lastInsertRowid });
  });

  r.put('/plans/:id', (req, res) => {
    const p = req.body || {};
    db.prepare(`
      UPDATE membership_plans SET name=?, tagline=?, price=?, interval_days=?, sessions_included=?, benefits=?, active=?, sort_order=?
      WHERE id=?`)
      .run(u.sanitize(p.name, 60), u.sanitize(p.tagline, 200), Number(p.price), Number(p.interval_days) || 30,
        p.sessions_included ? Number(p.sessions_included) : null, JSON.stringify(p.benefits || []),
        p.active ? 1 : 0, Number(p.sort_order) || 0, Number(req.params.id));
    u.ok(res, {});
  });

  r.delete('/plans/:id', (req, res) => {
    db.prepare('DELETE FROM membership_plans WHERE id = ?').run(Number(req.params.id));
    u.ok(res, {});
  });

  r.get('/members', (req, res) => {
    const rows = db.prepare(`
      SELECT m.*, p.name AS plan_name, p.price AS plan_price
      FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
      ORDER BY m.created_at DESC LIMIT 300`).all();
    u.ok(res, { members: rows });
  });

  r.patch('/members/:id', (req, res) => {
    const { sessions_used, status } = req.body || {};
    const m = db.prepare('SELECT * FROM memberships WHERE id = ?').get(Number(req.params.id));
    if (!m) return u.fail(res, 404, 'NOT_FOUND', 'Member not found.');
    db.prepare('UPDATE memberships SET sessions_used = ?, status = ? WHERE id = ?')
      .run(sessions_used != null ? Number(sessions_used) : m.sessions_used,
        ['active','expired','cancelled'].includes(status) ? status : m.status, m.id);
    u.ok(res, {});
  });

  /* ----------------------------- payments ----------------------------- */

  r.get('/payments', (req, res) => {
    const q = req.query;
    const where = [];
    const params = [];
    if (q.from) { where.push('p.created_at >= ?'); params.push(u.sanitize(q.from, 10) + 'T00:00:00.000Z'); }
    if (q.to) { where.push('p.created_at <= ?'); params.push(u.sanitize(q.to, 10) + 'T23:59:59.999Z'); }
    if (q.status) { where.push('p.status = ?'); params.push(u.sanitize(q.status, 12)); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT p.*, b.booking_reference, a.name AS activity_name
      FROM payments p LEFT JOIN bookings b ON b.id = p.booking_id LEFT JOIN activities a ON a.id = b.activity_id
      ${whereSql} ORDER BY p.created_at DESC LIMIT 400`).all(...params);
    const sum = (s) => rows.filter((x) => x.status === s).reduce((t, x) => t + x.amount, 0);
    u.ok(res, {
      payments: rows,
      summary: { revenue: sum('success') - sum('refunded'), successful: sum('success'), failed: sum('failed'), refunded: sum('refunded') },
    });
  });

  /* ----------------------------- analytics ----------------------------- */

  r.get('/analytics', (req, res) => {
    const today = u.todayStr();
    // daily bookings — last 30 days
    const daily = [];
    for (let i = 29; i >= 0; i--) {
      const d = u.addDays(today, -i);
      const row = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN payment_status='paid' THEN total_amount ELSE 0 END),0) AS rev
                              FROM bookings WHERE date = ? AND booking_status != 'cancelled'`).get(d);
      daily.push({ date: d, bookings: row.n, revenue: row.rev });
    }
    // monthly revenue — last 12 months
    const monthly = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = `${m.getFullYear()}-${u.pad(m.getMonth() + 1)}`;
      const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN payment_status='paid' THEN total_amount ELSE 0 END),0) AS rev
                              FROM bookings WHERE date LIKE ?`).get(ym + '%');
      monthly.push({ month: ym, revenue: row.rev });
    }
    // popular activities
    const popular = db.prepare(`
      SELECT a.name, COUNT(*) AS n FROM bookings b JOIN activities a ON a.id = b.activity_id
      WHERE b.booking_status != 'cancelled' GROUP BY a.id ORDER BY n DESC`).all();
    // peak times
    const peak = db.prepare(`
      SELECT start_time, COUNT(*) AS n FROM bookings WHERE booking_status != 'cancelled'
      GROUP BY start_time ORDER BY n DESC LIMIT 6`).all();
    // memberships
    const memberships = {
      active: db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE status='active'`).get().n,
      monthly: db.prepare(`SELECT COUNT(*) AS n FROM memberships m JOIN membership_plans p ON p.id=m.plan_id WHERE p.slug='monthly'`).get().n,
      unlimited: db.prepare(`SELECT COUNT(*) AS n FROM memberships m JOIN membership_plans p ON p.id=m.plan_id WHERE p.slug='unlimited'`).get().n,
      mrr: db.prepare(`SELECT COALESCE(SUM(p.price),0) AS s FROM memberships m JOIN membership_plans p ON p.id=m.plan_id WHERE m.status='active'`).get().s,
    };
    // repeat customers
    const repeat = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT customer_phone FROM bookings GROUP BY customer_phone HAVING COUNT(*) > 1
      )`).get().n;
    u.ok(res, { daily, monthly, popular, peak, memberships, repeat });
  });

  /* ----------------------------- notifications ----------------------------- */

  r.get('/notifications', (req, res) => {
    const rows = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100').all();
    const messages = db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 100').all();
    u.ok(res, { notifications: rows, messages });
  });

  /* ----------------------------- chatbot management ----------------------------- */

  r.get('/chatbot/settings', (req, res) => {
    const s = u.getSettings(db);
    const hasGroqEnv = !!process.env.GROQ_API_KEY;
    const hasOpenAIEnv = !!(process.env.OPENAI_API_KEY || process.env.AI_API_KEY);
    const defaultProvider = s.chatbot_provider || (hasGroqEnv || (s.chatbot_api_key && s.chatbot_api_key.startsWith('gsk_')) ? 'groq' : 'openai');

    u.ok(res, {
      settings: {
        enabled: s.chatbot_enabled !== 0 && s.chatbot_enabled !== '0' && s.chatbot_enabled !== false,
        name: s.chatbot_name || 'MindSpace Assistant',
        welcome: s.chatbot_welcome || 'Hey! 👋 Welcome to MindSpace Studio.\n\nLooking for something relaxing to do, checking a booking, or ready to find some calm headspace?',
        provider: defaultProvider,
        model: s.chatbot_model || (defaultProvider === 'groq' ? 'openai/gpt-oss-20b' : 'gpt-4o-mini'),
        api_base: s.chatbot_api_base || '',
        whatsapp: s.whatsapp || '',
        system_prompt: s.chatbot_system_prompt || '',
        has_api_key: !!(hasGroqEnv || hasOpenAIEnv || s.chatbot_api_key),
      },
    });
  });

  r.put('/chatbot/settings', (req, res) => {
    const b = req.body || {};
    if (b.enabled !== undefined) u.setSetting(db, 'chatbot_enabled', b.enabled ? 1 : 0);
    if (b.name !== undefined) u.setSetting(db, 'chatbot_name', u.sanitize(b.name, 60));
    if (b.welcome !== undefined) u.setSetting(db, 'chatbot_welcome', u.sanitize(b.welcome, 500));
    if (b.provider !== undefined) u.setSetting(db, 'chatbot_provider', u.sanitize(b.provider, 20));
    if (b.model !== undefined) u.setSetting(db, 'chatbot_model', u.sanitize(b.model, 60));
    if (b.api_base !== undefined) u.setSetting(db, 'chatbot_api_base', u.sanitize(b.api_base, 255));
    if (b.system_prompt !== undefined) u.setSetting(db, 'chatbot_system_prompt', u.sanitize(b.system_prompt, 2000));
    if (b.api_key !== undefined && b.api_key.trim()) {
      u.setSetting(db, 'chatbot_api_key', u.sanitize(b.api_key.trim(), 200));
    }
    u.ok(res, { saved: true });
  });

  r.get('/chatbot/analytics', (req, res) => {
    const totalConversations = db.prepare('SELECT COUNT(*) AS n FROM chat_conversations').get().n;
    const totalMessages = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user'").get().n;
    const toolCalls = db.prepare("SELECT COUNT(*) AS n FROM chat_events WHERE event_type = 'tool_call'").get().n;
    const whatsappClicks = db.prepare("SELECT COUNT(*) AS n FROM chat_events WHERE event_type = 'whatsapp'").get().n;
    const bookingsFromChat = db.prepare("SELECT COUNT(*) AS n FROM chat_events WHERE event_type = 'checkout_opened' OR event_type = 'booking_draft'").get().n;

    // Top used tools
    const topTools = db.prepare(`
      SELECT json_extract(payload, '$.tool') as tool_name, COUNT(*) as count
      FROM chat_events WHERE event_type = 'tool_call' AND payload IS NOT NULL
      GROUP BY tool_name ORDER BY count DESC LIMIT 8
    `).all();

    // Recent conversations
    const recentConversations = db.prepare(`
      SELECT c.id, c.session_id, c.created_at, c.updated_at,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS msg_count,
        (SELECT content FROM chat_messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY id ASC LIMIT 1) AS first_query
      FROM chat_conversations c ORDER BY c.updated_at DESC LIMIT 25
    `).all();

    u.ok(res, {
      stats: {
        totalConversations,
        totalMessages,
        toolCalls,
        whatsappClicks,
        bookingsFromChat,
      },
      topTools,
      recentConversations,
    });
  });

  r.get('/chatbot/conversations/:id', (req, res) => {
    const id = Number(req.params.id);
    const conv = db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id);
    if (!conv) return u.fail(res, 404, 'NOT_FOUND', 'Conversation not found.');
    const messages = db.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC').all(id);
    u.ok(res, { conversation: conv, messages });
  });

  return r;
};
