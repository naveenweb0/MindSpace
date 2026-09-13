# MindSpace Studio

**Create space for your mind. No experience. Just create.**

A complete, production-ready website, booking platform, and AI Studio Assistant for **MindSpace Studio** — a physical creative wellness studio. Visitors discover activities, pick durations, check real-time slot availability, pay online, receive confirmations, and interact with a virtual AI assistant. A full admin dashboard powers the studio management.

Built with **Node.js + Express + SQLite (better-sqlite3)** and **vanilla HTML/CSS/JS** — no heavy build step, minimal dependencies, and blazing-fast performance.

---

## Quick start

```bash
npm install        # install dependencies (express, better-sqlite3)
npm start          # boots server + seeds initial database on first run
```

Then open:

- **Website** → http://localhost:3000
- **Admin** → http://localhost:3000/admin

### Admin login

| Field    | Value                        |
| -------- | ---------------------------- |
| Email    | `admin@mindspacestudio.in`   |
| Password | `pause1234`                  |

---

## Features

### 🌟 Customer Website
- **Home** — editorial hero, floating cards, activity grid, "why us", how-it-works, memberships teaser
- **Sessions** — Painting, Clay Modelling, Mandala Making, Crafting & DIY, and Music Sessions
- **Book a Session** — Real-time availability, interactive duration & slot picker, instant reservation draft lock, and test checkout
- **Confirmation & Calendar** — Booking ID, instant .ics calendar invite download, directions, and WhatsApp integration
- **My Booking** — Look up bookings and active memberships by phone number, cancel or reschedule sessions
- **Memberships** — Drop-In, Monthly, and Unlimited plans
- **Our Space, About, FAQ, Contact & Legal pages**

### 🤖 MindSpace Assistant (AI Chatbot)
- Integrated AI virtual receptionist with Groq / OpenAI LLM support
- Understands customer emotions (stress, relaxation, curiosity) and gives personalized activity recommendations
- Real-time studio availability checks, session pricing, duration lookup, FAQ answering, and booking assistance
- Fallback heuristic engine for offline or zero-configuration use

### 📊 Studio Admin Dashboard (`/admin`)
- **Dashboard** — Live stats, today's schedule, capacity utilization, recent bookings
- **Bookings Management** — Filter, search, inspect, change status, cancel or reschedule bookings
- **Time Slots & Capacity** — Create, block, and manage date-specific slot capacity
- **Activities & Pricing** — Manage activities, pricing, and duration rules
- **Memberships** — Manage subscriber plans and active memberships
- **Chatbot Management** — Configure AI model, API keys, system prompt persona, and review conversation transcripts
- **Settings** — Studio address, opening hours, WhatsApp, social links, and cancellation policies

---

## Environment Variables

Copy `.env.example` to `.env`:

```env
PORT=3000
DB_PATH=data/pause-studio.db
GROQ_API_KEY=your_groq_api_key_here
CHATBOT_MODEL=openai/gpt-oss-20b
CHATBOT_PROVIDER=groq
```

---

## License

MIT
