'use strict';
/* Pause Assistant — AI Chatbot Engine for The Pause Studio.
 * Integrates database-driven tools, function calling, conversational booking,
 * slot holds, smart recommendations, and fallback natural language execution. */

const u = require('./util');
const slots = require('./slots');
const bookingEngine = require('./booking');
const payments = require('./payments');

/* ==========================================================================
   1. TOOL DEFINITIONS (OpenAI / JSON-Schema compatible)
   ========================================================================== */

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'getActivities',
      description: 'Get all active creative studio activities and pricing.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getActivityDetails',
      description: 'Get activity details by name or slug (painting, clay, mandala, crafting, music).',
      parameters: {
        type: 'object',
        properties: {
          activityIdOrSlug: { type: 'string', description: 'Activity slug' },
        },
        required: ['activityIdOrSlug'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getPricing',
      description: 'Get pricing for an activity (30m or 60m).',
      parameters: {
        type: 'object',
        properties: {
          activityIdOrSlug: { type: 'string', description: 'Activity slug' },
          duration: { type: 'number', description: '30 or 60' },
        },
        required: ['activityIdOrSlug'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getAvailableDates',
      description: 'Get open vs closed dates for a month.',
      parameters: {
        type: 'object',
        properties: {
          year: { type: 'number' },
          month: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getAvailableSlots',
      description: 'Check available time slots and remaining capacity for a date.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD' },
          duration: { type: 'number', description: '30 or 60' },
          guests: { type: 'number', description: 'Guest count' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkSlotAvailability',
      description: 'Check if a specific time slot on a date has room.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          startTime: { type: 'string' },
          duration: { type: 'number' },
          guests: { type: 'number' },
        },
        required: ['date', 'startTime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getMemberships',
      description: 'Get current studio membership tiers, prices, and benefits.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getStudioInfo',
      description: 'Get studio address, hours, contact, WhatsApp, and policies.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getFAQ',
      description: 'Get FAQ regarding beginner suitability, materials, and rules.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getBooking',
      description: 'Look up an existing booking by booking reference (e.g. TP-ABC123).',
      parameters: {
        type: 'object',
        properties: {
          bookingReference: { type: 'string', description: 'TP-XXXXXX' },
          phone: { type: 'string' },
        },
        required: ['bookingReference'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createBookingDraft',
      description: 'Create a booking draft before checkout.',
      parameters: {
        type: 'object',
        properties: {
          activityIdOrSlug: { type: 'string' },
          duration: { type: 'number' },
          date: { type: 'string' },
          startTime: { type: 'string' },
          guests: { type: 'number' },
          customerName: { type: 'string' },
          customerPhone: { type: 'string' },
        },
        required: ['activityIdOrSlug', 'date', 'startTime'],
      },
    },
  },
];

/* ==========================================================================
   2. TOOL IMPLEMENTATION LOGIC (Direct Database Access)
   ========================================================================== */

const tools = {
  getActivities: async (db) => {
    const acts = db.prepare('SELECT * FROM activities WHERE active = 1 ORDER BY sort_order').all();
    return acts.map((a) => {
      const durations = db.prepare('SELECT minutes, price FROM activity_durations WHERE activity_id = ? ORDER BY minutes').all(a.id);
      return {
        id: a.id,
        slug: a.slug,
        name: a.name,
        tagline: a.tagline,
        description: a.description,
        image: a.image,
        max_capacity: a.max_capacity,
        durations: durations.map((d) => ({ minutes: d.minutes, price: d.price, formattedPrice: `₹${d.price}` })),
      };
    });
  },

  getActivityDetails: async (db, args) => {
    const key = String(args.activityIdOrSlug || '').trim();
    const isNum = /^\d+$/.test(key);
    const a = db.prepare(`SELECT * FROM activities WHERE ${isNum ? 'id = ?' : 'LOWER(slug) = ?'} AND active = 1`).get(isNum ? Number(key) : key.toLowerCase());
    if (!a) return { found: false, message: `Activity "${key}" not found.` };
    const durations = db.prepare('SELECT minutes, price FROM activity_durations WHERE activity_id = ? ORDER BY minutes').all(a.id);
    return {
      found: true,
      activity: {
        id: a.id,
        slug: a.slug,
        name: a.name,
        tagline: a.tagline,
        description: a.description,
        image: a.image,
        max_capacity: a.max_capacity,
        durations: durations.map((d) => ({ minutes: d.minutes, price: d.price, formattedPrice: `₹${d.price}` })),
      },
    };
  },

  getPricing: async (db, args) => {
    const key = String(args.activityIdOrSlug || '').trim();
    const isNum = /^\d+$/.test(key);
    const a = db.prepare(`SELECT * FROM activities WHERE ${isNum ? 'id = ?' : 'LOWER(slug) = ?'} AND active = 1`).get(isNum ? Number(key) : key.toLowerCase());
    if (!a) return { found: false, message: `Activity "${key}" not found.` };
    const durations = db.prepare('SELECT minutes, price FROM activity_durations WHERE activity_id = ? ORDER BY minutes').all(a.id);
    if (args.duration) {
      const match = durations.find((d) => d.minutes === Number(args.duration));
      if (match) {
        return {
          activity: a.name,
          duration: match.minutes,
          price: match.price,
          formatted: `₹${match.price}`,
        };
      }
    }
    return {
      activity: a.name,
      durations: durations.map((d) => ({ duration: `${d.minutes} min`, price: d.price, formatted: `₹${d.price}` })),
    };
  },

  getAvailableDates: async (db, args) => {
    const now = new Date();
    const year = Number(args.year) || now.getFullYear();
    const month = Number(args.month) || now.getMonth() + 1;
    const settings = u.getSettings(db);
    const days = slots.calendarForMonth(db, year, month, settings);
    return {
      year,
      month,
      today: u.todayStr(),
      days: days.map((d) => ({
        date: d.date,
        dayOfWeek: d.dayOfWeek,
        isPast: d.isPast,
        isBlocked: d.isBlocked,
        isClosed: d.isClosed,
        isAvailable: !d.isPast && !d.isBlocked && !d.isClosed,
      })),
    };
  },

  getAvailableSlots: async (db, args) => {
    const date = u.sanitize(args.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Invalid date format. Please use YYYY-MM-DD.' };
    const settings = u.getSettings(db);
    const av = slots.availabilityForDate(db, date, settings);
    const guests = Number(args.guests) || 1;
    const openSlots = av.slots.filter((s) => !s.closed && s.left >= guests).map((s) => ({
      start: s.start,
      end: u.addMinutesToTime(s.start, Number(args.duration) || 30),
      formattedTime: u.fmtTime(s.start),
      remainingCapacity: s.left,
      totalCapacity: s.capacity,
    }));
    return {
      date,
      formattedDate: u.fmtDate(date),
      isClosed: av.isClosed,
      reason: av.reason,
      totalAvailableSlots: openSlots.length,
      slots: openSlots,
    };
  },

  checkSlotAvailability: async (db, args) => {
    const date = u.sanitize(args.date, 10);
    const startTime = u.sanitize(args.startTime, 5);
    const guests = Number(args.guests) || 1;
    const duration = Number(args.duration) || 30;
    const settings = u.getSettings(db);
    const av = slots.availabilityForDate(db, date, settings);
    const target = av.slots.find((s) => s.start === startTime);
    if (!target || target.closed || target.left < guests) {
      const alternatives = av.slots.filter((s) => !s.closed && s.left >= guests).slice(0, 4).map((s) => s.start);
      return {
        available: false,
        message: `The ${u.fmtTime(startTime)} slot on ${u.fmtDate(date)} is no longer available.`,
        alternatives: alternatives.map((t) => ({ time: t, formatted: u.fmtTime(t) })),
      };
    }
    return {
      available: true,
      date,
      startTime,
      formattedTime: u.fmtTime(startTime),
      remainingCapacity: target.left,
    };
  },

  getMemberships: async (db) => {
    const plans = db.prepare('SELECT * FROM membership_plans WHERE active = 1 ORDER BY sort_order').all()
      .map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        tagline: p.tagline,
        price: p.price,
        formattedPrice: `₹${p.price}/month`,
        interval_days: p.interval_days,
        sessions_included: p.sessions_included == null ? 'Unlimited' : p.sessions_included,
        benefits: JSON.parse(p.benefits || '[]'),
      }));
    return { plans };
  },

  getStudioInfo: async (db) => {
    const s = u.getSettings(db);
    const hours = db.prepare('SELECT * FROM opening_hours ORDER BY day_of_week').all();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return {
      studio_name: s.studio_name || 'MindSpace Studio',
      tagline: s.tagline || 'Create space for your mind. No experience. Just create.',
      address: [s.address_line1, s.address_line2, s.city].filter(Boolean).join(', ') || 'Studio location available in Mumbai',
      maps_url: s.maps_url || '',
      phone: s.phone || '',
      whatsapp: s.whatsapp || '',
      email: s.email || '',
      opening_hours: hours.map((h) => ({
        day: days[h.day_of_week],
        open: h.open_time,
        close: h.close_time,
        is_closed: !!h.is_closed,
        formatted: h.is_closed ? 'Closed' : `${u.fmtTime(h.open_time)} – ${u.fmtTime(h.close_time)}`,
      })),
      policies: {
        cancellation: s.cancellation_policy || 'Cancel or reschedule up to 2 hours before your session for a full refund.',
        children: s.children_policy || 'Children are welcome accompanied by an adult.',
        private_sessions: s.private_sessions || 'Not currently offered.',
      },
    };
  },

  getFAQ: async (db) => {
    const s = u.getSettings(db);
    return [
      { q: 'Do I need any previous experience?', a: 'None at all! Everything is beginner-friendly. No rules, no pressure, just enjoy the creative process.' },
      { q: 'Are materials provided?', a: 'Yes! All paints, canvases, brushes, air-dry clay, tools, mandala sheets, paper crafting supplies, and listening gear are provided.' },
      { q: 'Can I bring friends or a group?', a: 'Absolutely. You can select up to 8 guests per booking based on available table capacity.' },
      { q: 'What is the cancellation & rescheduling policy?', a: s.cancellation_policy || 'You can cancel or reschedule up to 2 hours before your session for a full refund.' },
      { q: 'Can children attend?', a: s.children_policy || 'Children are welcome when accompanied by an adult.' },
      { q: 'Can I take my creation home?', a: 'Yes! You can take your painting, craft, mandala, or dried clay pieces home with you.' },
    ];
  },

  getBooking: async (db, args) => {
    const ref = u.sanitize(args.bookingReference, 20).toUpperCase();
    const phone = u.sanitize(args.phone, 20);
    let b = null;
    if (phone) {
      b = db.prepare(`
        SELECT b.*, a.name AS activity_name, a.image AS activity_image
        FROM bookings b JOIN activities a ON a.id = b.activity_id
        WHERE b.booking_reference = ? AND b.customer_phone = ?`).get(ref, phone);
    } else {
      b = db.prepare(`
        SELECT b.*, a.name AS activity_name, a.image AS activity_image
        FROM bookings b JOIN activities a ON a.id = b.activity_id
        WHERE b.booking_reference = ?`).get(ref);
    }
    if (!b) return { found: false, message: 'No matching booking found. Please check the booking ID and mobile number.' };
    return {
      found: true,
      booking: {
        reference: b.booking_reference,
        customerName: b.customer_name,
        activity: b.activity_name,
        duration: `${b.duration} minutes`,
        date: b.date,
        formattedDate: u.fmtDate(b.date),
        time: `${u.fmtTime(b.start_time)} – ${u.fmtTime(b.end_time)}`,
        guests: b.number_of_guests,
        totalAmount: `₹${b.total_amount}`,
        bookingStatus: b.booking_status,
        paymentStatus: b.payment_status,
      },
    };
  },

  createBookingDraft: async (db, args) => {
    const settings = u.getSettings(db);
    const key = String(args.activityIdOrSlug || '').trim();
    const isNum = /^\d+$/.test(key);
    const act = db.prepare(`SELECT * FROM activities WHERE ${isNum ? 'id = ?' : 'LOWER(slug) = ?'} AND active = 1`).get(isNum ? Number(key) : key.toLowerCase());
    if (!act) return { error: `Activity "${key}" not found or inactive.` };

    const payload = {
      activity_id: act.id,
      duration: Number(args.duration) || 30,
      date: u.sanitize(args.date, 10),
      start_time: u.sanitize(args.startTime, 5),
      number_of_guests: Number(args.guests) || 1,
      customer_name: u.sanitize(args.customerName, 120),
      customer_phone: u.sanitize(args.customerPhone, 20),
      customer_email: u.sanitize(args.customerEmail, 120),
      note: u.sanitize(args.note, 500),
    };

    try {
      const res = bookingEngine.reserveBooking(db, settings, payload);
      const b = res.booking;
      return {
        success: true,
        booking: {
          booking_reference: b.booking_reference,
          view_token: b.view_token,
          activity_name: act.name,
          duration: b.duration,
          date: b.date,
          formattedDate: u.fmtDate(b.date),
          start_time: b.start_time,
          formattedTime: u.fmtTime(b.start_time),
          number_of_guests: b.number_of_guests,
          total_amount: b.total_amount,
          formattedAmount: `₹${b.total_amount}`,
          expires_at: b.expires_at,
        },
        checkoutUrl: `/book?step=payment&ref=${b.booking_reference}&token=${b.view_token}`,
      };
    } catch (err) {
      return { success: false, error: err.message, code: err.code };
    }
  },

  rescheduleBooking: async (db, args) => {
    const ref = u.sanitize(args.bookingReference, 20).toUpperCase();
    const phone = u.sanitize(args.phone, 20);
    const newDate = u.sanitize(args.newDate, 10);
    const newStartTime = u.sanitize(args.newStartTime, 5);
    const settings = u.getSettings(db);

    const b = db.prepare('SELECT * FROM bookings WHERE booking_reference = ?').get(ref);
    if (!b) return { success: false, error: 'Booking reference not found.' };
    if (phone && b.customer_phone !== phone) {
      return { success: false, error: 'Phone number does not match this booking.' };
    }

    try {
      const res = bookingEngine.rescheduleBooking(db, settings, ref, newDate, newStartTime);
      return {
        success: true,
        message: `Booking ${ref} has been rescheduled to ${u.fmtDate(newDate)} at ${u.fmtTime(newStartTime)}.`,
        booking: res.booking,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  cancelBooking: async (db, args) => {
    const ref = u.sanitize(args.bookingReference, 20).toUpperCase();
    const phone = u.sanitize(args.phone, 20);
    const b = db.prepare('SELECT * FROM bookings WHERE booking_reference = ?').get(ref);
    if (!b) return { success: false, error: 'Booking reference not found.' };
    if (phone && b.customer_phone !== phone) {
      return { success: false, error: 'Phone number does not match this booking.' };
    }

    try {
      const res = bookingEngine.cancelBooking(db, ref, 'customer');
      return {
        success: true,
        message: `Booking ${ref} has been cancelled.`,
        refunded: !!res.refunded,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
};

/* ==========================================================================
   3. EXECUTE TOOL DISPATCHER
   ========================================================================== */

async function executeTool(db, name, rawArgs) {
  let args = {};
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {});
  } catch (e) {
    args = {};
  }
  const fn = tools[name];
  if (!fn) return { error: `Tool ${name} not recognized.` };
  try {
    return await fn(db, args);
  } catch (e) {
    return { error: e.message || 'Tool execution failed.' };
  }
}

/* ==========================================================================
   4. SYSTEM PROMPT BUILDER
   ========================================================================== */

/* ==========================================================================
   4. SYSTEM PROMPT BUILDER
   ========================================================================== */

/* ==========================================================================
   4. SYSTEM PROMPT BUILDER
   ========================================================================== */

function buildSystemPrompt(db, customAdditions = '') {
  const settings = u.getSettings(db);
  const now = new Date();
  const todayStr = u.todayStr();
  const tmrStr = u.addDays(todayStr, 1);
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];

  return `You are MindSpace Assistant, the friendly, warm, and mindful AI studio guide for MindSpace Studio.
MindSpace Studio is a creative walk-in space in Mumbai where anyone can step in, relax, and create space for their mind with zero experience needed.
Available Studio Activities:
1. 🎨 Painting – Canvas & acrylics, freeform color expression. (30 min: ₹80, 60 min: ₹150)
2. 🏺 Clay Modelling – Tactile, calming air-dry clay shaping. (30 min: ₹100, 60 min: ₹180)
3. 🌀 Mandala Making – Intricate, mindful repetitive patterns. (30 min: ₹80, 60 min: ₹150)
4. ✂️ Crafting & DIY – Hands-on papercraft & playful creations. (30 min: ₹80, 60 min: ₹150)
5. 🎵 Music & Sound – Relaxing listening stations & instruments. (30 min: ₹80, 60 min: ₹150)

Current Studio Date & Time (IST): ${dayName}, ${todayStr} (${u.fmtTime(`${u.pad(now.getHours())}:${u.pad(now.getMinutes())}`)}). Tomorrow is ${tmrStr}.

Key Conversational Rules:
- Tone: Warm, empathetic, human, calm, and concise. Never corporate, never robotic, never repetitive.
- Casual greetings: If the user says "hi", "yooo", "hey", respond naturally and casually matching their vibe.
- Moods & Emotions: If the user expresses sadness, stress, exhaustion, or burnout (e.g. "I'm sad", "I feel overwhelmed", "stressed after college"), empathize warmly and suggest gentle creative activities to help them create space for their mind and take a breather. (You are a studio assistant, not a clinical therapist; never diagnose conditions).
- Real Data & Tools: When the user asks about live availability, pricing, or bookings, ALWAYS use the provided tools. Never invent seat numbers or prices.
- Conversational Booking: Guide users through Activity -> Duration -> Date -> Time -> Guests -> Checkout summary.

${customAdditions}`;
}

/* ==========================================================================
   5. NATURAL INTENT & FALLBACK ENGINE
   ========================================================================== */

async function processWithFallbackEngine(db, message, history = [], context = {}) {
  const text = String(message || '').toLowerCase().trim();
  const settings = u.getSettings(db);
  const toolExecutions = [];
  const quickActions = [];
  let reply = '';
  let smartAction = null;

  async function callTool(toolName, args, label) {
    toolExecutions.push({ name: toolName, label: label || `Running ${toolName}...` });
    return await executeTool(db, toolName, args);
  }

  function parseDateFromText(str) {
    const today = u.todayStr();
    if (/\b(today|tonight|this afternoon|this evening)\b/i.test(str)) return today;
    if (/\b(tomorrow|tmrw|tmr)\b/i.test(str)) return u.addDays(today, 1);
    if (/\bday after tomorrow\b/i.test(str)) return u.addDays(today, 2);
    const m = str.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (m) return m[1];
    return null;
  }

  // 1. Casual greetings (hi, yooo, hey, sup)
  if (/^(hi|hey|hello|yoo+|yo|what'?s up|sup|howdy|hola|greetings)\b/i.test(text) && text.length < 25) {
    if (/yoo+/i.test(text)) {
      reply = `Yooo 😄 What's up? Ready for a little creative break today? What kind of vibe are you feeling?`;
    } else {
      reply = `Hey! 👋 Welcome to MindSpace Studio. What kind of creative space do you need today — something calming, creative, or energizing?`;
    }
    quickActions.push(
      { label: '🎨 Find an activity', text: 'Suggest an activity for my mood' },
      { label: '💰 See prices', text: 'How much are the sessions?' },
      { label: '🗓️ Check availability', text: 'What slots are open tomorrow?' }
    );
  }

  // 2. Booking Reference Lookup
  else if (text.match(/\b(tp-[a-z0-9]+)\b/i) || /\b(my booking|find booking|lookup booking|booking status|track booking)\b/i.test(text)) {
    const refMatch = text.match(/\b(tp-[a-z0-9]+)\b/i);
    if (refMatch) {
      const bRes = await callTool('getBooking', { bookingReference: refMatch[1] }, 'Looking up booking…');
      if (bRes.found) {
        const b = bRes.booking;
        reply = `Here are your booking details:\n\n**ID:** ${b.reference}\n**Customer:** ${b.customerName}\n**Activity:** ${b.activity} (${b.duration})\n**When:** ${b.formattedDate} at ${b.time}\n**Status:** ${b.bookingStatus} (${b.paymentStatus})`;
        quickActions.push({ label: 'Manage on My Booking', action: 'navigate', url: '/my-booking' });
      } else {
        reply = `We couldn't find a booking with ID **${refMatch[1].toUpperCase()}**. You can check all bookings linked to your phone number on our lookup page.`;
        quickActions.push({ label: 'Find by Phone', action: 'navigate', url: '/my-booking' });
      }
    } else {
      reply = `To look up, reschedule, or cancel a booking, please provide your **Booking ID** (e.g. \`TP-ABC123\`) or search by your phone number on our My Booking page.`;
      quickActions.push({ label: 'Open My Booking', action: 'navigate', url: '/my-booking' });
    }
  }

  // 3. Sadness / Feeling Down
  else if (/\b(sad|unhappy|depressed|down|crying|lonely|heartbroken|terrible|bad day|low|hurting)\b/i.test(text)) {
    reply = `I'm sorry you're having a rough moment 💚. Let's make things a little lighter. I'd suggest something gentle and low-pressure, like **Painting** (letting colors take over) or a soothing **Music Session** with cozy headphones.\n\nWould you prefer something peaceful, hands-on, or creative?`;
    quickActions.push(
      { label: '🎨 Painting (Gentle)', text: 'Tell me about painting' },
      { label: '🎵 Music (Soothing)', text: 'Tell me about music sessions' },
      { label: '🏺 Clay (Hands-on)', text: 'Tell me about clay modelling' }
    );
  }

  // 4. Stress / Overwhelm / Exhaustion
  else if (/\b(stress|stressed|overwhelm|overwhelmed|anxious|anxiety|exhausted|burnout|burned out|tired|hectic|crazy day|busy|headache|pressure)\b/i.test(text)) {
    reply = `Sounds like you could use a proper reset 🌿. When the mind is full, working with your hands creates wonderful breathing space. **Clay Modelling** 🏺 or **Mandala Making** 🌀 are deeply calming.\n\nWould you like a quick 30-minute pause or a relaxed 60-minute session?`;
    quickActions.push(
      { label: '🏺 Clay (30 min)', text: 'Tell me about clay modelling' },
      { label: '🌀 Mandala (Focus)', text: 'Tell me about mandala making' },
      { label: '🗓️ Check Times Tomorrow', text: 'What slots are open tomorrow?' }
    );
  }

  // 5. Boredom / Looking for Fun
  else if (/\b(bored|fun|something to do|entertain|creative|hands|weekend|after work|after college)\b/i.test(text) && !/\b(price|cost|slot|available)\b/i.test(text)) {
    reply = `Let's shake off the routine! ✨ Here are fun things to dive into at MindSpace Studio:\n\n• 🎨 **Painting** — Splash colors freely on canvas\n• 🏺 **Clay Modelling** — Sculpt cute dishes, pottery & shapes\n• ✂️ **Crafting & DIY** — Cut, fold & make playful papercraft\n\nWhich one sounds like fun today?`;
    quickActions.push(
      { label: '🎨 Painting', text: 'How much is painting?' },
      { label: '🏺 Clay Modelling', text: 'How much is clay?' },
      { label: '✂️ Crafting', text: 'Tell me about crafting' }
    );
  }

  // 6. Pricing & Cost Inquiries
  else if (/\b(price|prices|cost|costs|rate|rates|fee|fees|how much|charges|pricing)\b/i.test(text)) {
    const slugMatch = (text.match(/\b(painting|clay|mandala|crafting|music)\b/i) || [])[1];
    if (slugMatch) {
      const p = await callTool('getPricing', { activityIdOrSlug: slugMatch }, 'Retrieving live pricing…');
      const durs = (p.durations || []).map((d) => `• ${d.duration}: **${d.formatted}**`).join('\n');
      reply = `Here is the current pricing for **${p.activity}**:\n\n${durs}\n\nAll tools, materials, and guidance are included!`;
      quickActions.push({ label: `Book ${p.activity}`, action: 'navigate', url: `/book?activity=${slugMatch}` }, { label: 'See All Activities', text: 'What activities do you have?' });
    } else {
      const acts = await callTool('getActivities', {}, 'Getting all activity rates…');
      const list = acts.map((a) => `• **${a.name}**: ${a.durations.map((d) => `${d.minutes}m = ${d.formattedPrice}`).join(', ')}`).join('\n');
      reply = `Here are our current session rates:\n\n${list}\n\nSessions start from just ₹80 and include all necessary materials!`;
      quickActions.push({ label: '📅 Book a Session', action: 'navigate', url: '/book' }, { label: '🌿 Memberships', text: 'Tell me about memberships' });
    }
  }

  // 7. Availability & Slot Checks
  else if (/\b(available|availability|slot|slots|open time|schedule|tomorrow|today|when can i|timing)\b/i.test(text) && !/\b(location|address|where)\b/i.test(text)) {
    const targetDate = parseDateFromText(text) || u.addDays(u.todayStr(), 1);
    const dateData = await callTool('getAvailableSlots', { date: targetDate, duration: 30, guests: 1 }, 'Checking live schedule…');
    if (dateData.isClosed) {
      reply = `The studio is closed on **${dateData.formattedDate}** (${dateData.reason || 'Closed'}). Would you like to check the next day?`;
      quickActions.push({ label: 'Check Next Day', text: `Slots on ${u.addDays(targetDate, 1)}` });
    } else if (!dateData.slots || !dateData.slots.length) {
      reply = `All standard slots for **${dateData.formattedDate}** are currently full! Would you like to check another date?`;
      quickActions.push({ label: 'Check Tomorrow', text: 'Slots tomorrow' });
    } else {
      const topSlots = dateData.slots.slice(0, 5);
      const slotList = topSlots.map((s) => `• **${s.formattedTime}** (${s.remainingCapacity} spot${s.remainingCapacity > 1 ? 's' : ''} left)`).join('\n');
      reply = `I found **${dateData.totalAvailableSlots} open slots** on **${dateData.formattedDate}**:\n\n${slotList}\n\nWhich time works best for you?`;
      topSlots.slice(0, 3).forEach((s) => {
        quickActions.push({ label: s.formattedTime, text: `I want ${s.formattedTime} on ${targetDate}` });
      });
      quickActions.push({ label: 'View Full Calendar', action: 'navigate', url: '/book' });
    }
  }

  // 8. Location & Hours
  else if (/\b(location|address|where|reach|map|directions|hours|open time|where is|where are you)\b/i.test(text)) {
    const info = await callTool('getStudioInfo', {}, 'Getting studio location & hours…');
    const openHours = info.opening_hours.slice(0, 4).map((h) => `• ${h.day}: ${h.formatted}`).join('\n');
    reply = `📍 **${info.studio_name}**\n${info.address}\n\n⏰ **Studio Hours:**\n${openHours}\n(Full hours on our Contact page)`;
    quickActions.push({ label: '📍 Open Map & Directions', action: 'navigate', url: '/contact' }, { label: '💬 Chat on WhatsApp', action: 'whatsapp', url: `https://wa.me/${info.whatsapp || '919876543210'}` });
  }

  // 9. Recommendations & Activity Suggestions
  else if (/\b(recommend|recommendation|recommendations|suggest|suggestion|suggestions|what do you recommend|help me choose)\b/i.test(text)) {
    reply = `I'd love to help you find your creative space! 🌿 Tell me what you're feeling right now — stressed, looking to make something with your hands, or just wanting peaceful downtime — and I'll match you with the right session.`;
    quickActions.push(
      { label: '🎨 Colorful & Free (Painting)', text: 'Tell me about painting' },
      { label: '🏺 Hands-on & Tactile (Clay)', text: 'Tell me about clay modelling' },
      { label: '🌀 Quiet & Focused (Mandala)', text: 'Tell me about mandala making' },
      { label: '🎵 Soothing Sound (Music)', text: 'Tell me about music sessions' }
    );
  }

  // 10. Specific Activity Details & List
  else if (/\b(what is|tell me about|explain|details on|about|what activities|activities|activity)\b/i.test(text)) {
    const slugMatch = (text.match(/\b(painting|clay|mandala|crafting|music)\b/i) || [])[1];
    if (slugMatch) {
      const data = await callTool('getActivityDetails', { activityIdOrSlug: slugMatch }, `Getting ${slugMatch} details…`);
      if (data.found) {
        const a = data.activity;
        const prices = a.durations.map((d) => `**${d.minutes} min** (${d.formattedPrice})`).join(' · ');
        reply = `**${a.name}**\n\n${a.description}\n\n⏱️ Available durations: ${prices}\nAll materials and guidance are provided!`;
        quickActions.push({ label: `Book ${a.name}`, action: 'navigate', url: `/book?activity=${a.slug}` }, { label: 'Check Availability', text: `What slots are available for ${a.name}?` });
      }
    } else {
      const acts = await callTool('getActivities', {}, 'Loading activities…');
      reply = `Here are our 5 creative activities at MindSpace Studio:\n\n${acts.map((a) => `• **${a.name}** — ${a.tagline || a.description.slice(0, 70) + '...'}`).join('\n')}\n\nAll sessions are 100% beginner-friendly and include all supplies!`;
      quickActions.push({ label: '🎨 Painting', text: 'Tell me about painting' }, { label: '🏺 Clay', text: 'Tell me about clay' }, { label: '🌀 Mandala', text: 'Tell me about mandala' }, { label: '💰 See Prices', text: 'See prices' });
    }
  }

  // 11. Memberships
  else if (/\b(member|membership|memberships|monthly|unlimited|pass|subscription)\b/i.test(text)) {
    const memData = await callTool('getMemberships', {}, 'Loading membership plans…');
    const list = memData.plans.map((p) => `**${p.name}** — **${p.formattedPrice}**\n${p.tagline}\n• ${p.benefits.join('\n• ')}`).join('\n\n');
    reply = `Here are our flexible studio memberships:\n\n${list}\n\nMemberships make regular creative pauses super easy!`;
    quickActions.push({ label: 'View Memberships', action: 'navigate', url: '/memberships' }, { label: 'Book Single Session', action: 'navigate', url: '/book' });
  }

  // 12. General / Out of scope / Catch-all
  else {
    reply = `I'm your virtual guide for MindSpace Studio! 🌿 I can help you pick a creative activity for your mood, check ticket prices, find tomorrow's open slots, or manage a booking.\n\nWhat would you like to explore today?`;
    quickActions.push(
      { label: '🎨 Find an activity', text: 'Suggest an activity for my mood' },
      { label: '💰 See prices', text: 'Show me prices' },
      { label: '🗓️ Check availability', text: 'What slots are open tomorrow?' }
    );
  }

  return {
    content: reply,
    tools: toolExecutions,
    actions: quickActions,
    action: smartAction,
  };
}

/* ==========================================================================
   6. LLM TOOL CALLING PIPELINE (Groq / OpenAI / Multi-Model Fallback)
   ========================================================================== */

async function processWithLLM(db, message, history = [], context = {}) {
  const settings = u.getSettings(db);

  // Resolve API Key
  const groqEnvKey = process.env.GROQ_API_KEY;
  const openaiEnvKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
  const storedKey = settings.chatbot_api_key;
  const apiKey = storedKey || groqEnvKey || openaiEnvKey;

  if (!apiKey) {
    console.log('[Pause Assistant] No API key configured -> using fallback engine');
    return await processWithFallbackEngine(db, message, history, context);
  }

  let provider = (settings.chatbot_provider || '').toLowerCase();
  if (!provider) {
    provider = (apiKey.startsWith('gsk_') || groqEnvKey) ? 'groq' : 'openai';
  }

  let baseUrl = settings.chatbot_api_base || '';
  let model = settings.chatbot_model || '';

  if (provider === 'groq') {
    baseUrl = baseUrl || process.env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
    model = model || process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
  } else if (provider === 'openai') {
    baseUrl = baseUrl || process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
    model = model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  } else {
    baseUrl = baseUrl || 'https://api.openai.com/v1';
    model = model || 'openai/gpt-oss-20b';
  }

  console.log(`[Pause Assistant] Request: "${message.slice(0, 50)}" | Provider: ${provider.toUpperCase()} | Model: ${model}`);

  const systemPrompt = buildSystemPrompt(db, settings.chatbot_system_prompt || '');
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-8).filter((m) => m.content && (m.role === 'user' || m.role === 'assistant')).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    })),
    {
      role: 'user',
      content: context.currentPage ? `[User is viewing ${context.currentPage}] ${message}` : message,
    },
  ];

  const toolExecutions = [];
  let iterations = 0;
  let finalContent = '';
  let smartAction = null;
  const groqPool = [model, 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'groq/compound-mini'].filter((m, i, a) => a.indexOf(m) === i);
  let poolIdx = 0;

  while (iterations < 4) {
    iterations++;
    const currentModel = provider === 'groq' ? groqPool[poolIdx % groqPool.length] : model;
    try {
      let response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: currentModel,
          messages,
          tools: TOOL_DEFINITIONS,
          tool_choice: 'auto',
          temperature: 0.7,
          max_tokens: 280,
        }),
      });

      // If rate-limited (429) on Groq, cycle to the next model in the pool
      if (response.status === 429 && provider === 'groq' && poolIdx < groqPool.length - 1) {
        poolIdx++;
        const nextModel = groqPool[poolIdx];
        console.warn(`[Pause Assistant] Rate-limited on ${currentModel}, switching to ${nextModel}...`);
        response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: nextModel,
            messages,
            tools: TOOL_DEFINITIONS,
            tool_choice: 'auto',
            temperature: 0.7,
            max_tokens: 280,
          }),
        });
      }

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`[Pause Assistant ${provider.toUpperCase()}] API error (${response.status}):`, errText);
        return await processWithFallbackEngine(db, message, history, context);
      }

      const json = await response.json();
      const choice = json.choices && json.choices[0];
      if (!choice) break;

      const msg = choice.message;
      messages.push(msg);

      if (msg.tool_calls && msg.tool_calls.length) {
        for (const tc of msg.tool_calls) {
          const fnName = tc.function.name;
          const fnArgs = tc.function.arguments;
          toolExecutions.push({ name: fnName, label: `Checking ${fnName.replace(/^get/, '')}…` });
          const result = await executeTool(db, fnName, fnArgs);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
          if (fnName === 'createBookingDraft' && result.success) {
            smartAction = { type: 'open_checkout', booking: result.booking, checkoutUrl: result.checkoutUrl };
          }
        }
      } else {
        finalContent = (msg.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        break;
      }
    } catch (apiErr) {
      console.warn(`[Pause Assistant ${provider.toUpperCase()}] Request failure:`, apiErr.message);
      return await processWithFallbackEngine(db, message, history, context);
    }
  }

  // Generate contextual quick action chips
  const quickActions = [];
  if (/painting/i.test(finalContent)) quickActions.push({ label: '🎨 Book Painting', action: 'navigate', url: '/book?activity=painting' });
  if (/clay/i.test(finalContent)) quickActions.push({ label: '🏺 Book Clay', action: 'navigate', url: '/book?activity=clay' });
  if (/slots|available|tomorrow/i.test(finalContent)) quickActions.push({ label: '🗓️ View Calendar', action: 'navigate', url: '/book' });
  if (/membership/i.test(finalContent)) quickActions.push({ label: '🌿 Memberships', action: 'navigate', url: '/memberships' });
  if (/whatsapp/i.test(finalContent)) quickActions.push({ label: '💬 Chat on WhatsApp', action: 'whatsapp', url: `https://wa.me/${settings.whatsapp || '919876543210'}` });

  return {
    content: finalContent || 'How else can I help you find your pause today? ✨',
    tools: toolExecutions,
    actions: quickActions,
    action: smartAction,
  };
}

/* ==========================================================================
   7. PUBLIC MODULE EXPORTS
   ========================================================================== */

module.exports = {
  TOOL_DEFINITIONS,
  tools,
  executeTool,
  processWithFallbackEngine,
  processWithLLM,
};


