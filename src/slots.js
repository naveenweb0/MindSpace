'use strict';
/* Slot generation + availability (availability is always computed BEFORE payment). */

const u = require('./util');

function openingHoursFor(db, dow) {
  return db.prepare('SELECT * FROM opening_hours WHERE day_of_week = ?').get(dow) || null;
}

function isBlockedDate(db, date) {
  return !!db.prepare('SELECT date FROM blocked_dates WHERE date = ?').get(date);
}
function isBlockedSlot(db, date, start) {
  return !!db.prepare('SELECT id FROM blocked_slots WHERE date = ? AND start_time = ?').get(date, start);
}
function slotCapacityFor(db, date, start, defaultCapacity) {
  const row = db.prepare('SELECT capacity FROM time_slots WHERE date = ? AND start_time = ?').get(date, start);
  return row && row.capacity != null ? row.capacity : defaultCapacity;
}

/** All slot start times for a given date, from opening hours + interval. */
function slotTimesForDate(db, date, settings) {
  const d = u.parseDate(date);
  const dow = d.getDay();
  const h = openingHoursFor(db, dow);
  const interval = Number(settings.slot_interval || 30);
  if (!h || h.is_closed || !h.open_time || !h.close_time) return [];
  const out = [];
  let t = h.open_time;
  const close = u.minutesOfDay(h.close_time);
  while (u.minutesOfDay(t) + interval <= close) {
    out.push(t);
    t = u.addMinutesToTime(t, interval);
  }
  return out;
}

const ACTIVE_STATUSES = `('pending','confirmed','attended','no_show')`;

/**
 * Count of guests already occupying a slot (pending holds not expired + confirmed + past statuses).
 * Expired unpaid holds are released lazily here and treated as free.
 */
function bookedGuestsForSlot(db, date, start, nowIso = u.nowIso()) {
  const rows = db.prepare(
    `SELECT number_of_guests, payment_status, expires_at FROM bookings
     WHERE date = ? AND start_time = ? AND booking_status IN ${ACTIVE_STATUSES}`
  ).all(date, start);
  let guests = 0;
  for (const r of rows) {
    // An unpaid pending booking whose hold has expired no longer reserves capacity.
    if (r.payment_status === 'unpaid' && r.expires_at && r.expires_at <= nowIso) continue;
    guests += r.number_of_guests;
  }
  return guests;
}

/** Full slot availability for a date + activity. */
function availabilityForDate(db, date, settings) {
  const today = u.todayStr();
  const d = u.parseDate(date);
  const dow = d.getDay();
  const h = openingHoursFor(db, dow);
  const defaultCapacity = Number(settings.slot_capacity || 8);
  const interval = Number(settings.slot_interval || 30);
  const past = date < today;
  const dayClosed = !h || h.is_closed || isBlockedDate(db, date);
  const slots = [];
  for (const t of slotTimesForDate(db, date, settings)) {
    const capacity = slotCapacityFor(db, date, t, defaultCapacity);
    const blocked = isBlockedSlot(db, date, t);
    const booked = dayClosed ? capacity : bookedGuestsForSlot(db, date, t);
    const left = Math.max(0, capacity - booked);
    const inPast = past || u.addMinutesToTime(t, interval) <= (date === today ? currentTimeHM() : '00:00');
    slots.push({
      start: t,
      end: u.addMinutesToTime(t, interval),
      capacity,
      booked,
      left,
      closed: dayClosed || blocked || inPast || left <= 0,
      reason: blocked ? 'blocked' : dayClosed ? 'closed' : inPast ? 'past' : left <= 0 ? 'full' : null,
    });
  }
  return { date, day: dow, open: !dayClosed, hours: h ? { open: h.open_time, close: h.close_time } : null, slots };
}

function currentTimeHM() {
  const d = new Date();
  return u.pad(d.getHours()) + ':' + u.pad(d.getMinutes());
}

/**
 * Calendar status for every day of a month:
 *  'past' | 'closed' (day closed / blocked) | 'full' (all slots full) | 'open'
 */
function calendarForMonth(db, year, month, settings) {
  const y = Number(year);
  const m = Number(month);
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = u.todayStr();
  const out = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${y}-${u.pad(m)}-${u.pad(day)}`;
    let status = 'open';
    if (date < today) {
      status = 'past';
    } else {
      const av = availabilityForDate(db, date, settings);
      if (!av.open) status = 'closed';
      else if (av.slots.length === 0) status = 'closed';
      else if (av.slots.every((s) => s.closed)) status = 'full';
    }
    out.push({ date, status });
  }
  return out;
}

module.exports = {
  openingHoursFor, isBlockedDate, isBlockedSlot, slotCapacityFor,
  slotTimesForDate, bookedGuestsForSlot, availabilityForDate, calendarForMonth,
  ACTIVE_STATUSES,
};
