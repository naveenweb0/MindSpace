'use strict';
/* Seed script — setup core database (admin, settings, activities, plans). Pass --demo for sample bookings. */

process.env.TZ = process.env.TZ || 'Asia/Kolkata';
const db = require('./db');
const u = require('./util');

const RESET = process.argv.includes('--reset') || process.argv.includes('--clean');
const WITH_DEMO = process.argv.includes('--demo');
const alreadySeeded = db.prepare('SELECT COUNT(*) AS n FROM activities').get().n > 0;

if (alreadySeeded && !RESET && !WITH_DEMO) {
  console.log('ℹ️  Database already initialized. Use `node src/seed.js --clean` to reset to clean state.');
  process.exit(0);
}

if (RESET || WITH_DEMO) {
  // wipe in FK-safe order
  for (const t of ['notifications','payments','memberships','booking_participants','bookings',
                   'contact_messages','membership_plans','activity_durations','activities',
                   'blocked_slots','blocked_dates','time_slots','opening_hours','studio_settings',
                   'admin_sessions','users']) {
    db.prepare(`DELETE FROM ${t}`).run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(t);
  }
}

const now = u.nowIso();

/* ----------------------------- settings ----------------------------- */

const defaults = {
  studio_name: 'MindSpace Studio',
  tagline: 'Create space for your mind. No experience. Just create.',
  phone: '',
  whatsapp: '',
  email: '',
  address_line1: '',
  address_line2: '',
  city: '',
  maps_url: '',
  instagram: '',
  slot_interval: 30,
  slot_capacity: 8,
  min_advance_hours: 1,
  max_lead_days: 30,
  cancellation_policy:
    'You can cancel or reschedule up to 2 hours before your session for a full refund. ' +
    'Cancellations after that are not refundable.',
  children_policy:
    'Children are welcome when accompanied by an adult. Sessions are designed for all ages.',
  private_sessions: 'Not currently offered.',
};
for (const [k, v] of Object.entries(defaults)) u.setSetting(db, k, v);

/* ----------------------------- opening hours ----------------------------- */

const hoursSeed = [
  { day: 0, open: '10:00', close: '18:00' }, // Sunday
  { day: 1, open: '10:00', close: '20:00' },
  { day: 2, open: '10:00', close: '20:00' },
  { day: 3, open: '10:00', close: '20:00' },
  { day: 4, open: '10:00', close: '20:00' },
  { day: 5, open: '10:00', close: '20:00' },
  { day: 6, open: '10:00', close: '20:00' },
];
const insHour = db.prepare(
  `INSERT INTO opening_hours (day_of_week, open_time, close_time, is_closed) VALUES (?, ?, ?, 0)`
);
for (const h of hoursSeed) insHour.run(h.day, h.open, h.close);

/* ----------------------------- activities ----------------------------- */

const activities = [
  {
    slug: 'painting', name: 'Painting', tagline: 'Pick your colors, put on some music and let the brush take over.',
    description: 'Grab a brush, pick a few colors you like and let the brush take over. A blank canvas is just a place to start — no reference, no rules.',
    image: '/img/activity-painting.jpg', durations: [[30, 80], [60, 150]], sort: 1,
  },
  {
    slug: 'clay', name: 'Clay Modelling', tagline: 'Shape something with your hands and give your mind something simple to focus on.',
    description: 'Squeeze, roll and shape soft air-dry clay. It is wonderfully forgiving — make a bowl, a blob, or just enjoy the feeling of it.',
    image: '/img/activity-clay.jpg', durations: [[30, 100], [60, 180]], sort: 2,
  },
  {
    slug: 'mandala', name: 'Mandala Making', tagline: 'Slow patterns, quiet focus and a little time away from the noise.',
    description: 'Dot by dot, line by line. Repeating patterns have a way of quieting a busy mind. No symmetry police here.',
    image: '/img/activity-mandala.jpg', durations: [[30, 80], [60, 150]], sort: 3,
  },
  {
    slug: 'crafting', name: 'Crafting', tagline: 'Cut, fold, build, decorate. There is no right way to make something.',
    description: 'Paper, glue, yarn, tape and whatever else catches your eye. Build something small and a little imperfect.',
    image: '/img/activity-crafting.jpg', durations: [[30, 80], [60, 140]], sort: 4,
  },
  {
    slug: 'music', name: 'Music Sessions', tagline: 'Put everything else on pause and spend some time simply listening.',
    description: 'A quiet corner, good headphones and a record player. Sit back, close your eyes, and let the music do the work.',
    image: '/img/activity-music.jpg', durations: [[30, 100], [60, 160]], sort: 5,
  },
];

const insAct = db.prepare(
  `INSERT INTO activities (slug, name, tagline, description, image, max_capacity, active, sort_order)
   VALUES (@slug, @name, @tagline, @description, @image, 8, 1, @sort)`
);
const insDur = db.prepare(
  `INSERT INTO activity_durations (activity_id, minutes, price) VALUES (?, ?, ?)`
);
const actIdBySlug = {};
for (const a of activities) {
  const r = insAct.run(a);
  actIdBySlug[a.slug] = r.lastInsertRowid;
  for (const [mins, price] of a.durations) insDur.run(r.lastInsertRowid, mins, price);
}

/* ----------------------------- membership plans ----------------------------- */

const insPlan = db.prepare(
  `INSERT INTO membership_plans (slug, name, tagline, price, interval_days, sessions_included, benefits, active, sort_order)
   VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
);
insPlan.run('monthly', 'Monthly', 'Make creative space part of your routine.', 699, 30, 4,
  JSON.stringify(['4 sessions every month', 'Member pricing on all sessions', 'Priority booking', 'Unused sessions roll over']), 1);
insPlan.run('unlimited', 'Unlimited', 'Come as often as your week allows.', 1499, 30, null,
  JSON.stringify(['Unlimited eligible sessions', 'Priority booking', 'Member perks & discounts', 'Bring a friend once a month']), 2);

/* ----------------------------- admin user ----------------------------- */

const insUser = db.prepare(
  `INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'admin')`
);
insUser.run('Studio Admin', 'admin@mindspacestudio.in', '', u.hashPassword('pause1234'));

/* ----------------------------- optional demo bookings ----------------------------- */

if (WITH_DEMO) {
  const today = u.todayStr();
  const yest = u.addDays(today, -1);
  const twoAgo = u.addDays(today, -2);
  const tmr = u.addDays(today, 1);
  const d3 = u.addDays(today, 3);

  const mk = (act, dur, guests, start, status, pay, date, over = {}) => ({
    act, dur, guests, start, status, pay, date: date || today, ...over,
  });

  const todayBookings = [
    mk('painting', 60, 1, '10:00', 'attended', 'paid'), mk('music', 60, 1, '10:00', 'attended', 'paid'),
    mk('clay', 60, 1, '10:30', 'attended', 'paid'), mk('clay', 30, 2, '10:30', 'attended', 'paid'),
    mk('painting', 60, 1, '11:00', 'attended', 'paid'), mk('music', 60, 1, '11:00', 'attended', 'paid'),
    mk('music', 60, 1, '11:30', 'attended', 'paid'), mk('clay', 60, 1, '11:30', 'attended', 'paid'),
  ];

  const CUSTOMERS = [
    ['Aarav Sharma', 'aarav.sharma@example.com', '9876500001'],
    ['Diya Patel', 'diya.patel@example.com', '9876500002'],
    ['Kabir Singh', 'kabir.singh@example.com', '9876500003'],
    ['Meera Iyer', 'meera.iyer@example.com', '9876500004'],
  ];

  const priceOf = (slug, dur) => {
    const a = activities.find((x) => x.slug === slug);
    const d = a.durations.find((x) => x[0] === dur);
    return d[1];
  };

  const insBooking = db.prepare(`
    INSERT INTO bookings (booking_reference, view_token, customer_name, customer_email, customer_phone,
                          activity_id, duration, date, start_time, end_time, number_of_guests,
                          total_amount, payment_status, booking_status, expires_at)
    VALUES (@ref, @token, @name, @email, @phone, @activity_id, @duration, @date, @start, @end,
            @guests, @amount, @pay, @status, NULL)
  `);
  const insPay = db.prepare(`
    INSERT INTO payments (booking_id, provider, provider_ref, amount, status, method, meta)
    VALUES (?, 'mock', ?, ?, ?, ?, ?)
  `);

  let i = 0;
  for (const b of todayBookings) {
    const c = CUSTOMERS[i % CUSTOMERS.length];
    i++;
    const amount = priceOf(b.act, b.dur) * b.guests;
    const end = u.addMinutesToTime(b.start, b.dur);
    const r = insBooking.run({
      ref: u.bookingRef(), token: u.randomToken(20),
      name: c[0], email: c[1], phone: c[2],
      activity_id: actIdBySlug[b.act], duration: b.dur,
      date: b.date, start: b.start, end,
      guests: b.guests, amount, pay: b.pay, status: b.status,
    });
    if (b.pay === 'paid') {
      insPay.run(r.lastInsertRowid, 'pay_' + u.randomString(14, 'abcdef0123456789'), amount, 'success', 'upi', '{}');
    }
  }
}

console.log('✅ Setup complete: 100% clean production state.');
console.log('   Admin login → email: admin@thepausestudio.in · password: pause1234');
console.log('   Activities: 5 · Membership plans: 2 · Bookings: ' + (WITH_DEMO ? 'seeded' : '0 (clean for real users)'));
process.exit(0);
