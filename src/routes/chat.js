'use strict';
/* Public Chatbot Routes for The Pause Studio. */

const express = require('express');
const u = require('../util');
const chatbot = require('../chatbot');

module.exports = function chatRoutes(db) {
  const r = express.Router();

  /* In-memory rate limiting */
  const rateLimits = new Map();
  function checkRateLimit(key) {
    const now = Date.now();
    const entry = rateLimits.get(key) || { count: 0, reset: now + 60 * 1000 };
    if (now > entry.reset) {
      entry.count = 0;
      entry.reset = now + 60 * 1000;
    }
    entry.count++;
    rateLimits.set(key, entry);
    return entry.count <= 40;
  }

  /* ----------------------------- public chat config ----------------------------- */

  r.get('/api/chat/config', (req, res) => {
    const s = u.getSettings(db);
    const enabled = s.chatbot_enabled !== 0 && s.chatbot_enabled !== '0' && s.chatbot_enabled !== false;
    u.ok(res, {
      config: {
        enabled,
        name: s.chatbot_name || 'MindSpace Assistant',
        welcome: s.chatbot_welcome || 'Hey! 👋 Welcome to MindSpace Studio.\n\nLooking for something relaxing to do, checking a booking, or ready to find some calm headspace?',
        whatsapp: s.whatsapp || '',
        quick_actions: [
          { label: '🎨 Find an activity', text: 'Help me choose an activity' },
          { label: '📅 Book a session', text: 'I want to book a session' },
          { label: '💰 See prices', text: 'How much are the sessions?' },
          { label: '🗓️ Check availability', text: 'What times are available tomorrow?' },
          { label: '💳 Memberships', text: 'Tell me about memberships' },
          { label: '📍 Studio location', text: 'Where is the studio located and what are your hours?' },
        ],
      },
    });
  });

  /* ----------------------------- send message ----------------------------- */

  r.post('/api/chat', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'ip';
    const { message, sessionId, context } = req.body || {};

    if (!checkRateLimit(ip)) {
      return u.fail(res, 429, 'RATE_LIMITED', 'You are chatting a bit fast! Please take a quick breath and try again in a minute. 🌿');
    }

    const cleanMsg = u.sanitize(message, 1000);
    if (!cleanMsg) {
      return u.fail(res, 400, 'EMPTY_MESSAGE', 'Please enter a message.');
    }

    const sId = u.sanitize(sessionId, 64) || u.randomToken(16);

    // Find or create conversation
    let conv = db.prepare('SELECT * FROM chat_conversations WHERE session_id = ?').get(sId);
    if (!conv) {
      const run = db.prepare('INSERT INTO chat_conversations (session_id, meta, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(sId, JSON.stringify(context || {}), u.nowIso(), u.nowIso());
      conv = { id: run.lastInsertRowid, session_id: sId };
      // Track chat opened
      db.prepare('INSERT INTO chat_events (conversation_id, event_type, payload) VALUES (?, ?, ?)')
        .run(conv.id, 'open', JSON.stringify({ page: (context && context.currentPage) || '/' }));
    } else {
      db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(u.nowIso(), conv.id);
    }

    // Retrieve previous conversation history
    const history = db.prepare('SELECT role, content, tool_calls, tool_results FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 20')
      .all(conv.id);

    // Persist user message
    db.prepare('INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)')
      .run(conv.id, 'user', cleanMsg);

    // Track first message or message event
    db.prepare('INSERT INTO chat_events (conversation_id, event_type, payload) VALUES (?, ?, ?)')
      .run(conv.id, 'message', JSON.stringify({ length: cleanMsg.length, textSnippet: cleanMsg.slice(0, 50) }));

    try {
      // Process response with LLM (or fallback engine)
      const assistantResult = await chatbot.processWithLLM(db, cleanMsg, history, context || {});

      // Persist assistant message
      db.prepare(`
        INSERT INTO chat_messages (conversation_id, role, content, tool_calls, actions)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        conv.id,
        'assistant',
        assistantResult.content,
        JSON.stringify(assistantResult.tools || []),
        JSON.stringify(assistantResult.actions || [])
      );

      // Track tool/action events if applicable
      if (assistantResult.tools && assistantResult.tools.length) {
        for (const t of assistantResult.tools) {
          db.prepare('INSERT INTO chat_events (conversation_id, event_type, payload) VALUES (?, ?, ?)')
            .run(conv.id, 'tool_call', JSON.stringify({ tool: t.name }));
        }
      }

      u.ok(res, {
        sessionId: conv.session_id,
        message: {
          role: 'assistant',
          content: assistantResult.content,
          tools: assistantResult.tools || [],
          actions: assistantResult.actions || [],
          action: assistantResult.action || null,
        },
      });
    } catch (e) {
      console.error('Chat error:', e);
      u.fail(res, 500, 'CHAT_ERROR', 'I had a tiny technical moment 😅 You can still book directly on our website or chat with us on WhatsApp.', {
        fallbackActions: [
          { label: '📅 Book a Session', action: 'navigate', url: '/book' },
          { label: '💬 Chat on WhatsApp', action: 'whatsapp', url: `https://wa.me/${u.getSetting(db, 'whatsapp', '919876543210')}` },
        ],
      });
    }
  });

  /* ----------------------------- chat history ----------------------------- */

  r.get('/api/chat/history/:sessionId', (req, res) => {
    const sId = u.sanitize(req.params.sessionId, 64);
    const conv = db.prepare('SELECT id FROM chat_conversations WHERE session_id = ?').get(sId);
    if (!conv) return u.ok(res, { messages: [] });
    const msgs = db.prepare('SELECT id, role, content, tool_calls, actions, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 50')
      .all(conv.id);
    u.ok(res, {
      messages: msgs.map((m) => ({
        role: m.role,
        content: m.content,
        tools: JSON.parse(m.tool_calls || '[]'),
        actions: JSON.parse(m.actions || '[]'),
        createdAt: m.created_at,
      })),
    });
  });

  /* ----------------------------- analytics event tracking ----------------------------- */

  r.post('/api/chat/events', (req, res) => {
    const { sessionId, eventType, payload } = req.body || {};
    const sId = u.sanitize(sessionId, 64);
    const conv = db.prepare('SELECT id FROM chat_conversations WHERE session_id = ?').get(sId);
    const validEvents = ['open', 'message', 'recommend', 'check_availability', 'booking_draft', 'checkout_opened', 'converted', 'whatsapp', 'close'];
    const evType = validEvents.includes(eventType) ? eventType : 'custom';
    db.prepare('INSERT INTO chat_events (conversation_id, event_type, payload) VALUES (?, ?, ?)')
      .run(conv ? conv.id : null, evType, JSON.stringify(payload || {}));
    u.ok(res, { recorded: true });
  });

  return r;
};
