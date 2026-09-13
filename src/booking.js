'use strict';
/* Booking engine — transaction-safe reservation & confirmation.
 * Availability is checked and capacity is held INSIDE a SQLite transaction, so
 * two customers can never book the same remaining capacity simultaneously. */

const u = require('./util');
const slots = require('./slots');

const HOLD_MINUTES = 15;

function getActivity(db, idOrSlug) {
  const isNum = /^\d+$/.test(String(idOrSlug));
  return db.prepare(`SELECT * FROM activities WHERE ${isNum ? 'id = ?' : 'slug = ?'} AND active = 1`)
    .get(idOrSlug);
}

function priceFor(db, activityId, minutes) {
  const r = db.prepare('SELECT price FROM activity_durations WHERE activity_id = ? AND minutes = ?').get(activityId, minutes);
  return r ? r.price : null;
}

/** Validate a date + time against opening hours and blocks. Returns {ok, error} */
function validateSlot(db, settings, date, start, duration, guests) {
  const today = u.todayStr();
  if (date < today) return { ok: false, error: 'DATE_PAST', message: 'That date has already passed.' };
  const maxLead = Number(settings.max_lead_days || 30);
  if (date > u.addDays(today, maxLead)) return { ok: false, error: 'DATE_TOO_FAR', message: `You can book up to ${maxLead} days ahead.` };
  if (slots.isBlockedDate(db, date)) return { ok: false, error: 'DAY_CLOSED', message: 'The studio is closed on this day.' };

  const h = slots.openingHoursFor(db, u.parseDate(date).getDay());
  if (!h || h.is_closed) return { ok: false, error: 'DAY_CLOSED', message: 'The studio is closed on this day.' };

  if (!u.isValidTime(start)) return { ok: false, error: 'BAD_TIME', message: 'Invalid time.' };
  const interval = Number(settings.slot_interval || 30);
  // start must align to a generated slot
  const validStarts = slots.slotTimesForDate(db, date, settings);
  if (!validStarts.includes(start)) return { ok: false, error: 'BAD_TIME', message: 'That time is outside opening hours.' };
  const end = u.addMinutesToTime(start, duration);
  const closeMin = u.minutesOfDay(h.close_time);
  if (u.minutesOfDay(end) > closeMin) return { ok: false, error: 'BAD_TIME', message: 'The session would run past closing time.' };

  if (slots.isBlockedSlot(db, date, start)) return { ok: false, error: 'SLOT_BLOCKED', message: 'That slot is not available.' };

  // minimum advance booking
  const minAdv = Number(settings.min_advance_hours || 0);
  if (date === today) {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    if (u.minutesOfDay(start) - nowMin < minAdv * 60) {
      return { ok: false, error: 'TOO_SOON', message: `Please pick a slot at least ${minAdv} hour(s) from now.` };
    }
  }
  if (!Number.isInteger(guests) || guests < 1) return { ok: false, error: 'BAD_GUESTS', message: 'Choose at least 1 guest.' };
  return { ok: true, end };
}

function bookedCountForSlot(db, date, start) {
  const r = db.prepare(
    `SELECT COALESCE(SUM(number_of_guests),0) AS n FROM bookings
     WHERE date = ? AND start_time = ? AND booking_status IN ('pending','confirmed','attended','no_show')
       AND NOT (payment_status = 'unpaid' AND expires_at IS NOT NULL AND expires_at <= ?)`
  ).get(date, start, u.nowIso());
  return r.n;
}

function slotCapacity(db, date, start, settings) {
  return slots.slotCapacityFor(db, date, start, Number(settings.slot_capacity || 8));
}

/**
 * Step 1 — reserve (create a pending booking, hold capacity for HOLD_MINUTES).
 * Returns the booking; payment then confirms it.
 */
function reserveBooking(db, settings, input) {
  const run = db.transaction(() => {
    const activity = getActivity(db, input.activity_id);
    if (!activity) return { error: 'ACTIVITY', message: 'That activity is not available right now.' };

    const duration = Number(input.duration);
    const price = priceFor(db, activity.id, duration);
    if (!price) return { error: 'DURATION', message: 'That duration is not offered for this activity.' };

    const guests = Number(input.number_of_guests);
    const name = u.sanitize(input.customer_name, 120);
    const phone = u.sanitize(input.customer_phone, 20);
    const email = u.sanitize(input.customer_email, 120);
    if (!name) return { error: 'NAME', message: 'Please enter your name.' };
    if (!u.validPhone(phone)) return { error: 'PHONE', message: 'Please enter a valid mobile number.' };
    if (email && !u.validEmail(email)) return { error: 'EMAIL', message: 'That email address doesn’t look right.' };

    const v = validateSlot(db, settings, input.date, input.start_time, duration, guests);
    if (!v.ok) return { error: v.error, message: v.message };

    const capacity = slotCapacity(db, input.date, input.start_time, settings);
    if (activity.max_capacity && guests > activity.max_capacity) {
      return { error: 'TOO_MANY', message: `This activity allows up to ${activity.max_capacity} guests per booking.` };
    }
    const booked = bookedCountForSlot(db, input.date, input.start_time);
    const left = capacity - booked;
    if (guests > left) {
      return { error: 'SLOT_FULL', message: 'That slot just filled up.', extra: { left } };
    }

    const ref = u.bookingRef();
    const expires = new Date(Date.now() + HOLD_MINUTES * 60 * 1000).toISOString();
    const total = price * guests;
    const r = db.prepare(`
      INSERT INTO bookings (booking_reference, view_token, customer_name, customer_email, customer_phone,
                            activity_id, duration, date, start_time, end_time, number_of_guests,
                            total_amount, payment_status, booking_status, note, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 'pending', ?, ?)
    `).run(ref, u.randomToken(24), name, email, phone, activity.id, duration,
      input.date, input.start_time, v.end, guests, total, u.sanitize(input.note, 500), expires);

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(r.lastInsertRowid);
    return { booking };
  });
  const result = run();
  if (result.error) {
    const err = new Error(result.message);
    err.code = result.error;
    err.extra = result.extra;
    throw err;
  }
  return result.booking;
}

/** Step 2 — confirm after successful payment (idempotent). */
function confirmBooking(db, bookingRef, pay) {
  const run = db.transaction(() => {
    const booking = db.prepare('SELECT * FROM bookings WHERE booking_reference = ?').get(bookingRef);
    if (!booking) return { error: 'NOT_FOUND', message: 'Booking not found.' };
    if (booking.payment_status === 'paid') return { booking }; // idempotent
    if (booking.booking_status === 'cancelled') return { error: 'CANCELLED', message: 'This booking was cancelled.' };
    if (booking.payment_status === 'unpaid' && booking.expires_at && booking.expires_at <= u.nowIso()) {
      return { error: 'EXPIRED', message: 'Your hold on this slot expired. Please book again.' };
    }
    db.prepare(`UPDATE bookings SET payment_status='paid', booking_status='confirmed', updated_at=? WHERE id=?`)
      .run(u.nowIso(), booking.id);
    db.prepare(`INSERT INTO payments (booking_id, provider, provider_ref, amount, status, method, meta)
                VALUES (?, ?, ?, ?, 'success', ?, ?)`)
      .run(booking.id, pay.provider || 'razorpay', pay.provider_ref || '', booking.total_amount,
        pay.method || 'upi', JSON.stringify(pay.meta || {}));
    return { booking: db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id) };
  });
  const result = run();
  if (result.error) { const e = new Error(result.message); e.code = result.error; throw e; }
  return result.booking;
}

/** Record a failed payment attempt. */
function failPayment(db, bookingRef, info) {
  const b = db.prepare('SELECT * FROM bookings WHERE booking_reference = ?').get(bookingRef);
  if (!b) return;
  db.prepare(`INSERT INTO payments (booking_id, provider, provider_ref, amount, status, method, meta)
              VALUES (?, ?, ?, ?, 'failed', ?, ?)`)
    .run(b.id, info.provider || 'razorpay', info.provider_ref || '', b.total_amount, info.method || 'upi',
      JSON.stringify(info.meta || {}));
}

/** Release expired pending holds. */
function releaseExpiredHolds(db) {
  const r = db.prepare(
    `UPDATE bookings SET booking_status='cancelled', payment_status='failed', updated_at=?
     WHERE booking_status='pending' AND payment_status='unpaid' AND expires_at IS NOT NULL AND expires_at <= ?`
  ).run(u.nowIso(), u.nowIso());
  return r.changes;
}

/** Customer/admin cancellation. */
function cancelBooking(db, ref, by = 'customer') {
  const run = db.transaction(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE booking_reference = ?').get(ref);
    if (!b) return { error: 'NOT_FOUND' };
    if (b.booking_status === 'cancelled') return { booking: b };
    if (['attended', 'no_show'].includes(b.booking_status)) return { error: 'CANNOT_CANCEL' };
    db.prepare(`UPDATE bookings SET booking_status='cancelled', updated_at=? WHERE id=?`).run(u.nowIso(), b.id);
    let refunded = false;
    if (b.payment_status === 'paid') {
      db.prepare(`UPDATE bookings SET payment_status='refunded' WHERE id=?`).run(b.id);
      db.prepare(`INSERT INTO payments (booking_id, provider, amount, status, method, meta)
                  VALUES (?, 'mock', ?, 'refunded', 'refund', ?)`)
        .run(b.id, b.total_amount, JSON.stringify({ by }));
      refunded = true;
    }
    return { booking: db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id), refunded };
  });
  const r = run();
  if (r.error) { const e = new Error('This booking can’t be cancelled.'); e.code = r.error; throw e; }
  return r;
}

/** Admin refund (mark paid → refunded, keep status). */
function refundBooking(db, ref) {
  const b = db.prepare('SELECT * FROM bookings WHERE booking_reference = ?').get(ref);
  if (!b) throw new Error('Booking not found.');
  if (b.payment_status !== 'paid') return b;
  db.prepare(`UPDATE bookings SET payment_status='refunded', updated_at=? WHERE id=?`).run(u.nowIso(), b.id);
  db.prepare(`INSERT INTO payments (booking_id, provider, amount, status, method, meta)
              VALUES (?, 'mock', ?, 'refunded', 'refund', ?)`).run(b.id, b.total_amount, JSON.stringify({ by: 'admin' }));
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
}

/** Reschedule to a new date+time, re-checking capacity atomically. */
function rescheduleBooking(db, settings, ref, newDate, newStart) {
  const run = db.transaction(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE booking_reference = ?').get(ref);
    if (!b) return { error: 'NOT_FOUND' };
    if (b.booking_status === 'cancelled' || b.booking_status === 'attended') return { error: 'CANNOT_RESCHEDULE' };
    const v = validateSlot(db, settings, newDate, newStart, b.duration, b.number_of_guests);
    if (!v.ok) return { error: v.error, message: v.message };
    const capacity = slotCapacity(db, newDate, newStart, settings);
    const booked = bookedCountForSlot(db, newDate, newStart);
    // allow rescheduling within the same slot (already counted once)
    const selfCount = (b.date === newDate && b.start_time === newStart) ? b.number_of_guests : 0;
    if (booked - selfCount + b.number_of_guests > capacity) {
      return { error: 'SLOT_FULL', message: 'That slot doesn’t have enough space.' };
    }
    db.prepare(`UPDATE bookings SET date=?, start_time=?, end_time=?, updated_at=? WHERE id=?`)
      .run(newDate, newStart, v.end, u.nowIso(), b.id);
    return { booking: db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id) };
  });
  const r = run();
  if (r.error) { const e = new Error(r.message || 'Could not reschedule.'); e.code = r.error; throw e; }
  return r;
}

module.exports = {
  getActivity, priceFor, validateSlot, reserveBooking, confirmBooking, failPayment,
  releaseExpiredHolds, cancelBooking, refundBooking, rescheduleBooking,
  slotCapacity, HOLD_MINUTES,
};
