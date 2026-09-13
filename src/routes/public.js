'use strict';
/* Public API — booking, availability, memberships, contact. */

const express = require('express');
const u = require('../util');
const slots = require('../slots');
const booking = require('../booking');
const payments = require('../payments');
const notify = require('../notify');

module.exports = function publicRoutes(db) {
  const r = express.Router();

  /* ----------------------------- settings ----------------------------- */

  r.get('/api/settings', (req, res) => {
    const settings = u.getSettings(db);
    const hours = db.prepare('SELECT * FROM opening_hours ORDER BY day_of_week').all();
    const plans = db.prepare('SELECT * FROM membership_plans WHERE active = 1 ORDER BY sort_order').all()
      .map((p) => ({ ...p, benefits: JSON.parse(p.benefits || '[]') }));
    // Never leak admin-only info; this is a deliberately small public surface.
    const pub = {
      studio_name: settings.studio_name,
      tagline: settings.tagline,
      phone: settings.phone || '',
      whatsapp: settings.whatsapp || '',
      email: settings.email || '',
      address_line1: settings.address_line1 || '',
      address_line2: settings.address_line2 || '',
      city: settings.city || '',
      maps_url: settings.maps_url || '',
      instagram: settings.instagram || '',
      slot_interval: settings.slot_interval,
      slot_capacity: settings.slot_capacity,
      cancellation_policy: settings.cancellation_policy || '',
      children_policy: settings.children_policy || '',
      private_sessions: settings.private_sessions || '',
      min_advance_hours: settings.min_advance_hours,
      max_lead_days: settings.max_lead_days,
      opening_hours: hours,
      plans,
    };
    u.ok(res, { settings: pub });
  });

  /* ----------------------------- activities ----------------------------- */

  r.get('/api/activities', (req, res) => {
    const acts = db.prepare('SELECT * FROM activities WHERE active = 1 ORDER BY sort_order').all();
    const out = acts.map((a) => {
      const durations = db.prepare('SELECT minutes, price FROM activity_durations WHERE activity_id = ? ORDER BY minutes').all(a.id);
      return { ...a, durations };
    });
    u.ok(res, { activities: out });
  });

  /* ----------------------------- availability ----------------------------- */

  r.get('/api/availability/calendar', (req, res) => {
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const settings = u.getSettings(db);
    u.ok(res, { days: slots.calendarForMonth(db, year, month, settings), year, month });
  });

  r.get('/api/availability', (req, res) => {
    const date = u.sanitize(req.query.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return u.fail(res, 400, 'BAD_DATE', 'Invalid date.');
    const settings = u.getSettings(db);
    u.ok(res, { availability: slots.availabilityForDate(db, date, settings) });
  });

  /* ----------------------------- bookings ----------------------------- */

  r.post('/api/bookings', async (req, res) => {
    try {
      const settings = u.getSettings(db);
      const b = booking.reserveBooking(db, settings, req.body || {});
      let order = null;
      try { order = await payments.createOrder(b); }
      catch (e) { return u.fail(res, 502, 'PAYMENT_SETUP', 'Could not start the payment. Please try again.'); }
      u.ok(res, {
        booking: {
          booking_reference: b.booking_reference,
          view_token: b.view_token,
          activity_id: b.activity_id,
          duration: b.duration,
          date: b.date,
          start_time: b.start_time,
          end_time: b.end_time,
          number_of_guests: b.number_of_guests,
          total_amount: b.total_amount,
          expires_at: b.expires_at,
        },
        payment: order,
      });
    } catch (e) {
      const map = {
        SLOT_FULL: [409, 'That slot just filled up. Pick another time and we’ll get you sorted.', e.extra],
        EXPIRED: [410, 'Your hold on that slot expired. Please pick a time again.'],
      };
      const [status, message, extra] = map[e.code] || [400, e.message];
      u.fail(res, status, e.code || 'BOOKING_FAILED', message, extra);
    }
  });

  // Confirm after successful payment (mock or verified Razorpay).
  r.post('/api/payments/verify', async (req, res) => {
    try {
      const { booking_ref, method, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
      const cleanRef = u.sanitize(booking_ref, 20);
      const b = db.prepare('SELECT * FROM bookings WHERE booking_reference = ?').get(cleanRef);
      if (!b) return u.fail(res, 404, 'NOT_FOUND', 'Booking not found.');

      if (razorpay_order_id && payments.razorpayEnabled()) {
        if (!payments.verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
          booking.failPayment(db, b.booking_reference, { provider: 'razorpay', provider_ref: razorpay_payment_id, method });
          return u.fail(res, 400, 'PAYMENT_INVALID', 'Payment verification failed.');
        }
        const confirmed = booking.confirmBooking(db, b.booking_reference, { provider: 'razorpay', provider_ref: razorpay_payment_id, method });
        try { await notify.sendBookingConfirmation(db, confirmed, u.getSettings(db)); } catch (_) {}
        return u.ok(res, { booking: confirmed });
      }

      // Demo/Mock mode — approve all payments immediately!
      const confirmed = booking.confirmBooking(db, b.booking_reference, {
        provider: 'mock',
        provider_ref: 'demo_' + u.randomString(10),
        method: method || 'upi'
      });
      try { await notify.sendBookingConfirmation(db, confirmed, u.getSettings(db)); } catch (_) {}
      return u.ok(res, { booking: confirmed, test_mode: true });
    } catch (e) {
      console.error('Payment verify error:', e);
      return u.fail(res, 400, 'PAYMENT_FAILED', e.message || 'Payment could not be confirmed.');
    }
  });

  r.post('/api/payments/fail', (req, res) => {
    const { booking_ref, method } = req.body || {};
    booking.failPayment(db, u.sanitize(booking_ref, 20), { provider: 'razorpay', method });
    u.ok(res, { recorded: true });
  });

  // View a booking with ID + phone/email (privacy check).
  // List a customer's bookings by phone (upcoming + past).
  r.post('/api/bookings/by-phone', (req, res) => {
    const phone = u.sanitize((req.body || {}).phone, 20);
    if (!u.validPhone(phone)) return u.fail(res, 400, 'PHONE', 'Enter a valid mobile number.');
    const rows = db.prepare(`
      SELECT b.*, a.name AS activity_name, a.image AS activity_image
      FROM bookings b JOIN activities a ON a.id = b.activity_id
      WHERE b.customer_phone = ? ORDER BY b.date DESC, b.start_time DESC LIMIT 50`).all(phone);
    u.ok(res, { bookings: rows });
  });

  r.post('/api/bookings/lookup', (req, res) => {    const { ref, token, phone, email } = req.body || {};
    const clean = u.sanitize(ref, 20);
    let b = null;
    if (token) b = db.prepare('SELECT * FROM bookings WHERE booking_reference = ? AND view_token = ?').get(clean, u.sanitize(token, 64));
    if (!b && phone) {
      const rows = db.prepare('SELECT * FROM bookings WHERE booking_reference = ? AND customer_phone = ?').all(clean, u.sanitize(phone, 20));
      if (rows.length === 1) b = rows[0];
    }
    if (!b) return u.fail(res, 404, 'NOT_FOUND', 'We couldn’t find that booking. Check your booking ID and phone number.');
    const a = db.prepare('SELECT * FROM activities WHERE id = ?').get(b.activity_id);
    u.ok(res, { booking: { ...b, activity: a } });
  });

  r.post('/api/bookings/:ref/cancel', (req, res) => {
    try {
      const result = booking.cancelBooking(db, u.sanitize(req.params.ref, 20), 'customer');
      u.ok(res, { booking: result.booking, refunded: !!result.refunded });
    } catch (e) {
      u.fail(res, 400, e.code || 'CANCEL_FAILED', e.message);
    }
  });

  r.post('/api/bookings/:ref/reschedule', (req, res) => {
    try {
      const settings = u.getSettings(db);
      const b = booking.rescheduleBooking(db, settings, u.sanitize(req.params.ref, 20), req.body.date, req.body.start_time);
      u.ok(res, { booking: b.booking });
    } catch (e) {
      u.fail(res, 400, e.code || 'RESCHEDULE_FAILED', e.message);
    }
  });

  /* ----------------------------- memberships ----------------------------- */

  r.get('/api/memberships/plans', (req, res) => {
    const plans = db.prepare('SELECT * FROM membership_plans WHERE active = 1 ORDER BY sort_order').all()
      .map((p) => ({ ...p, benefits: JSON.parse(p.benefits || '[]') }));
    u.ok(res, { plans });
  });

  r.post('/api/memberships/purchase', async (req, res) => {
    const { plan_id, name, phone, email, mock } = req.body || {};
    const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ? AND active = 1').get(Number(plan_id));
    if (!plan) return u.fail(res, 400, 'PLAN', 'That plan is not available.');
    const cname = u.sanitize(name, 120);
    const cphone = u.sanitize(phone, 20);
    const cemail = u.sanitize(email, 120);
    if (!cname) return u.fail(res, 400, 'NAME', 'Please enter your name.');
    if (!u.validPhone(cphone)) return u.fail(res, 400, 'PHONE', 'Please enter a valid mobile number.');
    if (cemail && !u.validEmail(cemail)) return u.fail(res, 400, 'EMAIL', 'That email address doesn’t look right.');

    const start = u.todayStr();
    const end = u.addDays(start, plan.interval_days);
    const ref = u.membershipRef();
    const token = u.randomToken(24);
    const run = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO memberships (membership_reference, view_token, plan_id, customer_name, customer_email, customer_phone,
                                 price_paid, start_date, end_date, sessions_used, sessions_total, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active')`)
        .run(ref, token, plan.id, cname, cemail, cphone, plan.price, start, end, plan.sessions_included);
      const id = r.lastInsertRowid;
      db.prepare(`INSERT INTO payments (membership_id, provider, amount, status, method, meta)
                  VALUES (?, ?, ?, 'initiated', ?, ?)`)
        .run(id, mock ? 'mock' : 'razorpay', plan.price, 'upi', '{}');
      return id;
    });
    const id = run();

    if (mock) {
      db.prepare(`UPDATE payments SET status='success' WHERE membership_id=? AND status='initiated'`).run(id);
      const m = db.prepare('SELECT * FROM memberships WHERE id = ?').get(id);
      await notify.sendMembershipConfirmation(db, m, plan, u.getSettings(db));
      return u.ok(res, { membership: m, plan, paid: true, test_mode: true });
    }
    const order = await payments.createOrder({ total_amount: plan.price, booking_reference: ref });
    return u.ok(res, { membership: db.prepare('SELECT * FROM memberships WHERE id = ?').get(id), plan, paid: false, payment: order });
  });

  r.post('/api/memberships/by-phone', (req, res) => {
    const phone = u.sanitize((req.body || {}).phone, 20);
    if (!u.validPhone(phone)) return u.fail(res, 400, 'PHONE', 'Enter a valid mobile number.');
    const rows = db.prepare(`
      SELECT m.*, p.name AS plan_name, p.price AS plan_price
      FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
      WHERE m.customer_phone = ? ORDER BY m.created_at DESC LIMIT 20`).all(phone);
    u.ok(res, { memberships: rows });
  });

  r.post('/api/memberships/lookup', (req, res) => {    const { ref, token, phone } = req.body || {};
    let m = null;
    if (token) m = db.prepare('SELECT * FROM memberships WHERE membership_reference = ? AND view_token = ?').get(u.sanitize(ref, 20), u.sanitize(token, 64));
    if (!m && phone) {
      const rows = db.prepare('SELECT * FROM memberships WHERE membership_reference = ? AND customer_phone = ?').all(u.sanitize(ref, 20), u.sanitize(phone, 20));
      if (rows.length === 1) m = rows[0];
    }
    if (!m) return u.fail(res, 404, 'NOT_FOUND', 'We couldn’t find that membership.');
    const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(m.plan_id);
    u.ok(res, { membership: { ...m, plan } });
  });

  /* ----------------------------- contact ----------------------------- */

  r.post('/api/contact', (req, res) => {
    const { name, email, phone, message } = req.body || {};
    const msg = u.sanitize(message, 2000);
    if (!msg) return u.fail(res, 400, 'EMPTY', 'Please write a short message.');
    db.prepare('INSERT INTO contact_messages (name, email, phone, message) VALUES (?, ?, ?, ?)')
      .run(u.sanitize(name, 120), u.sanitize(email, 120), u.sanitize(phone, 20), msg);
    notify.queue(db, { type: 'contact', channel: 'system', recipient: u.sanitize(email, 120), subject: 'Contact form', payload: { name, phone, message: msg } });
    u.ok(res, { received: true });
  });

  return r;
};
