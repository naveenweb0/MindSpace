'use strict';
/* Pause Assistant — Frontend Widget for The Pause Studio. */

(function () {
  const SESSION_KEY = 'tps_bot_session_id';
  const VISITED_KEY = 'tps_bot_visited';

  let sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = 'pbot_' + Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
    localStorage.setItem(SESSION_KEY, sessionId);
  }

  let botConfig = {
    enabled: true,
    name: 'MindSpace Assistant',
    welcome: 'Hey! 👋 Welcome to MindSpace Studio.\n\nLooking for something relaxing to do, checking a booking, or ready to find some calm headspace?',
    whatsapp: '',
    quick_actions: [
      { label: '🎨 Find an activity', text: 'Help me choose an activity' },
      { label: '📅 Book a session', text: 'I want to book a session' },
      { label: '💰 See prices', text: 'How much are the sessions?' },
      { label: '🗓️ Check availability', text: 'What times are available tomorrow?' },
      { label: '💳 Memberships', text: 'Tell me about memberships' },
      { label: '📍 Studio location', text: 'Where is the studio located and what are your hours?' },
    ],
  };

  let isOpen = false;
  let isSending = false;

  /* Helper to escape HTML */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* Simple markdown parser for bubbles */
  function formatMarkdown(text) {
    if (!text) return '';
    let html = esc(text);
    // Bold
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Bullet lists
    html = html.replace(/^• (.*)$/gm, '<li style="margin-left:14px">$1</li>');
    // Wrap lists
    html = html.replace(/((?:<li[^>]*>.*<\/li>\s*)+)/g, '<ul style="padding-left:4px;margin:6px 0">$1</ul>');
    // Line breaks
    html = html.replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
    return html;
  }

  /* Post JSON helper */
  async function postJSON(url, data) {
    const fullUrl = (url.startsWith('/api') && window.API_BASE) ? window.API_BASE + url : url;
    const res = await fetch(fullUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return await res.json().catch(() => ({ ok: false, message: 'Network error' }));
  }

  /* Build UI DOM */
  function initDOM() {
    // Floating Trigger Button
    const trigger = document.createElement('button');
    trigger.className = 'pause-bot-trigger';
    trigger.id = 'pauseBotTrigger';
    trigger.setAttribute('aria-label', 'Open MindSpace Assistant Chat');
    trigger.innerHTML = `
      <span class="pause-bot-badge" id="pauseBotBadge"></span>
      <svg class="icon-chat" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
      <svg class="icon-close" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    `;
    document.body.appendChild(trigger);

    // Floating Teaser Bubble
    const teaser = document.createElement('div');
    teaser.className = 'pause-bot-teaser';
    teaser.id = 'pauseBotTeaser';
    teaser.innerHTML = `
      <span>Here to help you find your headspace ✨</span>
      <button class="close-teaser" aria-label="Close message">✕</button>
    `;
    document.body.appendChild(teaser);

    // Chat Window
    const win = document.createElement('div');
    win.className = 'pause-bot-window';
    win.id = 'pauseBotWindow';
    win.innerHTML = `
      <header class="pause-bot-header">
        <div class="pause-bot-header-left">
          <div class="pause-bot-avatar">🌿</div>
          <div class="pause-bot-title-wrap">
            <h3 id="pauseBotName">MindSpace Assistant</h3>
            <p><span class="live-dot"></span> Online · Studio Reception</p>
          </div>
        </div>
        <div class="pause-bot-header-actions">
          <button class="pause-bot-btn-icon" id="pauseBotReset" title="Restart conversation">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></svg>
          </button>
          <button class="pause-bot-btn-icon" id="pauseBotClose" title="Minimize chat">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </header>

      <div class="pause-bot-messages" id="pauseBotMessages"></div>

      <div class="pause-bot-footer">
        <form class="pause-bot-form" id="pauseBotForm">
          <input class="pause-bot-input" id="pauseBotInput" type="text" placeholder="Ask anything or book a session…" autocomplete="off" maxlength="800">
          <button class="pause-bot-send" id="pauseBotSend" type="submit" aria-label="Send message">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </form>
      </div>
    `;
    document.body.appendChild(win);

    // Event listeners
    trigger.addEventListener('click', toggleChat);
    document.getElementById('pauseBotClose').addEventListener('click', closeChat);
    document.getElementById('pauseBotReset').addEventListener('click', resetChat);
    document.getElementById('pauseBotForm').addEventListener('submit', onFormSubmit);

    teaser.addEventListener('click', (e) => {
      if (e.target.classList.contains('close-teaser')) {
        e.stopPropagation();
        teaser.classList.remove('show');
      } else {
        openChat();
      }
    });

    // First time visitor prompt
    if (!localStorage.getItem(VISITED_KEY)) {
      setTimeout(() => {
        if (!isOpen) teaser.classList.add('show');
      }, 3500);
    } else {
      const badge = document.getElementById('pauseBotBadge');
      if (badge) badge.style.display = 'none';
    }
  }

  function toggleChat() {
    if (isOpen) closeChat();
    else openChat();
  }

  function openChat() {
    isOpen = true;
    localStorage.setItem(VISITED_KEY, '1');
    const badge = document.getElementById('pauseBotBadge');
    if (badge) badge.style.display = 'none';
    const teaser = document.getElementById('pauseBotTeaser');
    if (teaser) teaser.classList.remove('show');

    const trigger = document.getElementById('pauseBotTrigger');
    const win = document.getElementById('pauseBotWindow');
    if (trigger) trigger.classList.add('is-open');
    if (win) win.classList.add('is-open');

    // Focus input on desktop
    if (window.innerWidth > 640) {
      setTimeout(() => {
        const inp = document.getElementById('pauseBotInput');
        if (inp) inp.focus();
      }, 150);
    }

    scrollToBottom();
    postJSON('/api/chat/events', { sessionId, eventType: 'open', payload: { page: window.location.pathname } });
  }

  function closeChat() {
    isOpen = false;
    const trigger = document.getElementById('pauseBotTrigger');
    const win = document.getElementById('pauseBotWindow');
    if (trigger) trigger.classList.remove('is-open');
    if (win) win.classList.remove('is-open');
  }

  function scrollToBottom() {
    const el = document.getElementById('pauseBotMessages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  /* Render single message bubble */
  function renderMessage(role, content, tools, actions, isDraft) {
    const container = document.getElementById('pauseBotMessages');
    if (!container) return;

    const row = document.createElement('div');
    row.className = `pbot-msg-row ${role}`;

    let toolsHtml = '';
    if (tools && tools.length) {
      tools.forEach((t) => {
        toolsHtml += `<div class="pbot-tool-status"><span class="spin-dot"></span>${esc(t.label || t.name)}</div>`;
      });
    }

    let bubbleHtml = `<div class="pbot-bubble">${formatMarkdown(content)}</div>`;

    let actionsHtml = '';
    if (actions && actions.length) {
      actionsHtml = `<div class="pbot-chips-wrap">`;
      actions.forEach((a) => {
        actionsHtml += `<button class="pbot-chip" data-action='${JSON.stringify(a)}'>${esc(a.label || a.text)}</button>`;
      });
      actionsHtml += `</div>`;
    }

    row.innerHTML = toolsHtml + bubbleHtml + actionsHtml;
    container.appendChild(row);

    // Wire chips
    row.querySelectorAll('.pbot-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        try {
          const act = JSON.parse(btn.dataset.action);
          handleAction(act);
        } catch (_) {}
      });
    });

    scrollToBottom();
  }

  function handleAction(act) {
    if (act.action === 'navigate' && act.url) {
      window.location.href = act.url;
    } else if (act.action === 'whatsapp' && act.url) {
      window.open(act.url, '_blank');
      postJSON('/api/chat/events', { sessionId, eventType: 'whatsapp', payload: { url: act.url } });
    } else if (act.text) {
      sendMessage(act.text);
    }
  }

  /* Typing indicator */
  function showTyping(label) {
    removeTyping();
    const container = document.getElementById('pauseBotMessages');
    if (!container) return;

    const el = document.createElement('div');
    el.className = 'pbot-msg-row assistant';
    el.id = 'pbotTypingRow';
    el.innerHTML = `
      ${label ? `<div class="pbot-tool-status"><span class="spin-dot"></span>${esc(label)}</div>` : ''}
      <div class="pbot-typing"><span></span><span></span><span></span></div>
    `;
    container.appendChild(el);
    scrollToBottom();
  }

  function removeTyping() {
    const el = document.getElementById('pbotTypingRow');
    if (el) el.remove();
  }

  /* Send message */
  async function sendMessage(text) {
    if (isSending || !text || !text.trim()) return;
    const clean = text.trim();
    isSending = true;

    const input = document.getElementById('pauseBotInput');
    const sendBtn = document.getElementById('pauseBotSend');
    if (input) input.value = '';
    if (sendBtn) sendBtn.disabled = true;

    // Render user message immediately
    renderMessage('user', clean);
    showTyping('Pause Assistant is thinking…');

    try {
      const res = await postJSON('/api/chat', {
        message: clean,
        sessionId,
        context: {
          currentPage: window.location.pathname,
          title: document.title,
        },
      });

      removeTyping();
      if (res.ok && res.message) {
        renderMessage('assistant', res.message.content, res.message.tools, res.message.actions);
        if (res.message.action) {
          if (res.message.action.type === 'navigate') {
            setTimeout(() => { window.location.href = res.message.action.url; }, 800);
          } else if (res.message.action.type === 'open_checkout') {
            postJSON('/api/chat/events', { sessionId, eventType: 'checkout_opened', payload: res.message.action.booking });
          }
        }
      } else {
        renderMessage('assistant', res.message || 'I had a tiny technical moment 😅 You can still book directly on our website or chat on WhatsApp.', [], [
          { label: '📅 Book a Session', action: 'navigate', url: '/book' },
          { label: '💬 WhatsApp', action: 'whatsapp', url: `https://wa.me/${botConfig.whatsapp || '919876543210'}` },
        ]);
      }
    } catch (e) {
      removeTyping();
      renderMessage('assistant', 'Sorry about that! You can still book directly on our booking page or talk to us on WhatsApp.', [], [
        { label: '📅 Book a Session', action: 'navigate', url: '/book' },
      ]);
    } finally {
      isSending = false;
      if (sendBtn) sendBtn.disabled = false;
      if (input && window.innerWidth > 640) input.focus();
    }
  }

  function onFormSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('pauseBotInput');
    if (input && input.value.trim()) {
      sendMessage(input.value.trim());
    }
  }

  function resetChat() {
    sessionId = 'pbot_' + Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
    localStorage.setItem(SESSION_KEY, sessionId);
    const container = document.getElementById('pauseBotMessages');
    if (container) container.innerHTML = '';
    renderWelcome();
  }

  function renderWelcome() {
    renderMessage('assistant', botConfig.welcome, [], botConfig.quick_actions);
  }

  /* Load config and conversation history */
  async function boot() {
    initDOM();
    try {
      const cfgUrl = window.API_BASE ? window.API_BASE + '/api/chat/config' : '/api/chat/config';
      const cfgRes = await fetch(cfgUrl).then((r) => r.json()).catch(() => ({}));
      if (cfgRes.ok && cfgRes.config) {
        botConfig = { ...botConfig, ...cfgRes.config };
        if (!botConfig.enabled) {
          const trigger = document.getElementById('pauseBotTrigger');
          if (trigger) trigger.style.display = 'none';
          return;
        }
        const nameEl = document.getElementById('pauseBotName');
        if (nameEl) nameEl.textContent = botConfig.name;
      }

      // Load history
      const histUrl = window.API_BASE ? window.API_BASE + `/api/chat/history/${sessionId}` : `/api/chat/history/${sessionId}`;
      const histRes = await fetch(histUrl).then((r) => r.json()).catch(() => ({}));
      if (histRes.ok && histRes.messages && histRes.messages.length > 0) {
        histRes.messages.forEach((m) => {
          renderMessage(m.role, m.content, m.tools, m.actions);
        });
      } else {
        renderWelcome();
      }
    } catch (e) {
      renderWelcome();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
