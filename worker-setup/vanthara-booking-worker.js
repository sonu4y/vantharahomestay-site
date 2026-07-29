/**
 * VANTHARA BOOKING & PAYMENTS — Cloudflare Worker
 * =================================================
 * The backend for online booking + payment on vantharahomestay.com.
 * Guests pick dates on the site, pay via Razorpay (cards, UPI, netbanking,
 * wallets), and you get an email + see the booking on the admin dashboard's
 * "Bookings" tab. No card details ever touch this Worker — Razorpay's
 * Checkout handles that, and we only verify a signature afterwards.
 *
 * DEPLOY (about 20 minutes the first time):
 *
 * 1. Cloudflare dashboard → Workers & Pages → Create → Worker.
 *    Name it: vanthara-booking → Deploy the hello-world → Edit code.
 * 2. Delete the sample code, paste THIS ENTIRE FILE, click Deploy.
 *
 * 3. Create the database (one time):
 *    Workers & Pages → Storage & Databases → D1 SQLite Database → Create.
 *    Name it: vanthara-bookings → Create.
 *    Then open this Worker → Settings → Bindings → Add → D1 Database →
 *    Variable name: DB → select "vanthara-bookings" → Save.
 *    (The Worker creates its own table automatically on first request —
 *    nothing else to run.)
 *
 * 4. Worker → Settings → Variables and Secrets → add these:
 *      RAZORPAY_KEY_ID       (Text)    from Razorpay Dashboard → Settings → API Keys
 *      RAZORPAY_KEY_SECRET   (Secret)  from the same screen — shown only once, save it
 *      RAZORPAY_WEBHOOK_SECRET (Secret) any strong random string you invent —
 *                                       you'll enter this same value in Razorpay's
 *                                       webhook settings in step 6
 *      RESEND_API_KEY        (Secret)  from resend.com → API Keys → Create
 *      ADMIN_EMAIL            (Text)   vantharahomestay@gmail.com
 *      ADMIN_KEY              (Secret) any strong random string you invent;
 *                                      you'll enter the same value in the
 *                                      admin dashboard's Bookings → Settings
 *                                      (you can reuse the same key as the
 *                                      Instagram publisher Worker, or pick a new one)
 *      ALLOWED_ORIGIN          (Text)  https://vantharahomestay.com
 *
 *    GETTING RAZORPAY KEYS — sign up free at razorpay.com. New accounts
 *    start in TEST MODE automatically, so you can get Test API Keys
 *    immediately (Settings → API Keys → Generate Test Key) and try the
 *    whole flow with fake cards before any real money is involved. To
 *    accept real payments, complete Razorpay's KYC/business verification
 *    (usually 1–2 days), switch the dashboard to Live mode, generate LIVE
 *    keys, and replace the two secrets above with the live values.
 *    Test card: 4111 1111 1111 1111, any future expiry, any CVV.
 *    Test UPI: success@razorpay
 *
 *    GETTING RESEND KEY — sign up free at resend.com (3,000 emails/month
 *    free, no card needed) → API Keys → Create API Key → copy it. You do
 *    NOT need to verify a domain to get started — emails send from
 *    onboarding@resend.dev to your inbox immediately. Verifying
 *    vantharahomestay.com later (Resend → Domains) lets you send from
 *    your own address instead — optional, purely cosmetic.
 *
 * 5. Copy the Worker URL (https://vanthara-booking.<you>.workers.dev)
 *    into the admin dashboard's Bookings → Settings, alongside your
 *    ADMIN_KEY.
 *
 * 6. (Recommended) Set up a Razorpay webhook as a safety net, in case a
 *    guest closes their browser right after paying before the site can
 *    confirm it: Razorpay Dashboard → Settings → Webhooks → Add New
 *    Webhook → URL: https://vanthara-booking.<you>.workers.dev/api/razorpay-webhook
 *    → Secret: same value as RAZORPAY_WEBHOOK_SECRET above → Active
 *    events: payment.captured, payment.failed → Save.
 *
 * 7. PRICING — edit the CONFIG block directly below and re-deploy
 *    whenever your rates change. WEEKEND_DAYS uses JS day numbers:
 *    0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.
 *
 * Endpoints:
 *   GET  /api/availability                 → public, list of booked nights
 *   POST /api/create-order                 → public, {checkin,checkout,name,email,phone,guests}
 *   POST /api/verify-payment               → public, {booking_id,razorpay_order_id,razorpay_payment_id,razorpay_signature}
 *   POST /api/razorpay-webhook             → Razorpay only (signature-checked)
 *   GET  /api/bookings                     → admin (X-Admin-Key header)
 *   POST /api/bookings/:id/cancel          → admin (X-Admin-Key header)
 *   GET  /api/me                           → admin, quick stats for "test connection"
 */

/* ── PRICING CONFIG — EDIT THESE ────────────────────────────────── */
const CONFIG = {
  WEEKDAY_RATE: 12000,      // ₹ per night, Sun–Thu
  WEEKEND_RATE: 15000,      // ₹ per night, Fri & Sat
  WEEKEND_DAYS: [5, 6],     // Fri=5, Sat=6 (JS Date.getDay())
  CURRENCY: 'INR',
};
/* ─────────────────────────────────────────────────────────────── */

const RAZORPAY_API = 'https://api.razorpay.com/v1';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      await ensureSchema(env);

      // --- public: availability ---
      if (url.pathname === '/api/availability' && request.method === 'GET') {
        const nights = await getBlockedNights(env);
        return json({ blocked: nights });
      }

      // --- public: create Razorpay order ---
      if (url.pathname === '/api/create-order' && request.method === 'POST') {
        return await handleCreateOrder(request, env, json);
      }

      // --- public: verify payment after Checkout succeeds ---
      if (url.pathname === '/api/verify-payment' && request.method === 'POST') {
        return await handleVerifyPayment(request, env, json);
      }

      // --- Razorpay webhook (its own signature, not X-Admin-Key) ---
      if (url.pathname === '/api/razorpay-webhook' && request.method === 'POST') {
        return await handleWebhook(request, env, json);
      }

      // --- everything below requires the admin key ---
      if (url.pathname.startsWith('/api/bookings') || url.pathname === '/api/me') {
        if (!env.ADMIN_KEY || request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
          return json({ error: 'Unauthorized' }, 401);
        }
      }

      if (url.pathname === '/api/me' && request.method === 'GET') {
        const stats = await getStats(env);
        return json({ ok: true, ...stats });
      }

      if (url.pathname === '/api/bookings' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM bookings ORDER BY checkin ASC'
        ).all();
        return json({ bookings: results });
      }

      const cancelMatch = url.pathname.match(/^\/api\/bookings\/(\d+)\/cancel$/);
      if (cancelMatch && request.method === 'POST') {
        const id = cancelMatch[1];
        await env.DB.prepare(
          "UPDATE bookings SET status='cancelled', updated_at=? WHERE id=?"
        ).bind(new Date().toISOString(), id).run();
        return json({ ok: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

/* ── SCHEMA ─────────────────────────────────────────────────────── */
async function ensureSchema(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_name TEXT,
      email TEXT,
      phone TEXT,
      guests TEXT,
      checkin TEXT NOT NULL,
      checkout TEXT NOT NULL,
      nights INTEGER,
      amount INTEGER,
      currency TEXT DEFAULT 'INR',
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT,
      updated_at TEXT
    )
  `).run();
}

/* ── PRICING ────────────────────────────────────────────────────── */
function nightRate(dateStr) {
  const day = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return CONFIG.WEEKEND_DAYS.includes(day) ? CONFIG.WEEKEND_RATE : CONFIG.WEEKDAY_RATE;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function computeQuote(checkin, checkout) {
  const nights = [];
  let cur = checkin;
  while (cur < checkout) {
    nights.push({ date: cur, rate: nightRate(cur) });
    cur = addDays(cur, 1);
  }
  const total = nights.reduce((s, n) => s + n.rate, 0);
  return { nights: nights.length, breakdown: nights, totalRupees: total, amountPaise: total * 100 };
}

/* ── AVAILABILITY ───────────────────────────────────────────────── */
async function getBlockedNights(env) {
  // Paid bookings block forever. Pending ones only block for 30 minutes
  // (an abandoned checkout shouldn't lock dates permanently).
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT checkin, checkout FROM bookings
     WHERE status = 'paid' OR (status = 'pending' AND created_at > ?)`
  ).bind(cutoff).all();

  const nights = new Set();
  for (const b of results) {
    let cur = b.checkin;
    while (cur < b.checkout) {
      nights.add(cur);
      cur = addDays(cur, 1);
    }
  }
  return Array.from(nights).sort();
}

async function hasConflict(env, checkin, checkout) {
  const blocked = new Set(await getBlockedNights(env));
  let cur = checkin;
  while (cur < checkout) {
    if (blocked.has(cur)) return true;
    cur = addDays(cur, 1);
  }
  return false;
}

/* ── CREATE ORDER ───────────────────────────────────────────────── */
async function handleCreateOrder(request, env, json) {
  const body = await request.json().catch(() => ({}));
  const { checkin, checkout, name, email, phone, guests } = body;

  if (!checkin || !checkout || !/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout)) {
    return json({ error: 'Valid checkin and checkout dates (YYYY-MM-DD) are required' }, 400);
  }
  if (checkout <= checkin) return json({ error: 'Check-out must be after check-in' }, 400);
  const today = new Date().toISOString().slice(0, 10);
  if (checkin < today) return json({ error: 'Check-in date is in the past' }, 400);
  if (!name || !phone) return json({ error: 'Name and phone are required' }, 400);

  if (await hasConflict(env, checkin, checkout)) {
    return json({ error: 'Sorry, those dates just got booked. Please pick different dates.' }, 409);
  }

  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    return json({ error: 'Payments are not configured yet on the server. Please contact the host directly.' }, 500);
  }

  const quote = computeQuote(checkin, checkout);
  const receipt = 'vt_' + Date.now();

  const auth = btoa(env.RAZORPAY_KEY_ID + ':' + env.RAZORPAY_KEY_SECRET);
  const orderRes = await fetch(RAZORPAY_API + '/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
    body: JSON.stringify({
      amount: quote.amountPaise,
      currency: CONFIG.CURRENCY,
      receipt,
      notes: { checkin, checkout, name, email: email || '', phone, guests: guests || '' },
    }),
  });
  const order = await orderRes.json();
  if (!order.id) {
    return json({ error: 'Could not create payment order', detail: order }, 502);
  }

  const now = new Date().toISOString();
  const insert = await env.DB.prepare(
    `INSERT INTO bookings
     (guest_name, email, phone, guests, checkin, checkout, nights, amount, currency, razorpay_order_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(name, email || '', phone, guests || '', checkin, checkout, quote.nights, quote.amountPaise, CONFIG.CURRENCY, order.id, now, now).run();

  return json({
    booking_id: insert.meta.last_row_id,
    order_id: order.id,
    amount: quote.amountPaise,
    currency: CONFIG.CURRENCY,
    key_id: env.RAZORPAY_KEY_ID,
    nights: quote.nights,
    total_rupees: quote.totalRupees,
  });
}

/* ── VERIFY PAYMENT ─────────────────────────────────────────────── */
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleVerifyPayment(request, env, json) {
  const body = await request.json().catch(() => ({}));
  const { booking_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
  if (!booking_id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return json({ error: 'Missing payment details' }, 400);
  }

  const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(booking_id).first();
  if (!row || row.razorpay_order_id !== razorpay_order_id) {
    return json({ error: 'Booking not found' }, 404);
  }

  const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, razorpay_order_id + '|' + razorpay_payment_id);
  if (expected !== razorpay_signature) {
    return json({ success: false, error: 'Signature verification failed' }, 400);
  }

  if (row.status !== 'paid') {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE bookings SET status='paid', razorpay_payment_id=?, updated_at=? WHERE id=?"
    ).bind(razorpay_payment_id, now, booking_id).run();
    await sendAdminEmail(env, { ...row, razorpay_payment_id, status: 'paid' });
  }

  return json({ success: true });
}

/* ── RAZORPAY WEBHOOK (backup confirmation path) ────────────────── */
async function handleWebhook(request, env, json) {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Razorpay-Signature') || '';

  if (!env.RAZORPAY_WEBHOOK_SECRET) return json({ ok: false }, 500);
  const expected = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, rawBody);
  if (expected !== signature) return json({ ok: false, error: 'Bad signature' }, 400);

  const evt = JSON.parse(rawBody);
  const entity = evt?.payload?.payment?.entity;
  if (!entity) return json({ ok: true });

  const orderId = entity.order_id;
  const row = await env.DB.prepare('SELECT * FROM bookings WHERE razorpay_order_id = ?').bind(orderId).first();
  if (!row) return json({ ok: true });

  const now = new Date().toISOString();
  if (evt.event === 'payment.captured' && row.status !== 'paid') {
    await env.DB.prepare(
      "UPDATE bookings SET status='paid', razorpay_payment_id=?, updated_at=? WHERE id=?"
    ).bind(entity.id, now, row.id).run();
    await sendAdminEmail(env, { ...row, razorpay_payment_id: entity.id, status: 'paid' });
  } else if (evt.event === 'payment.failed' && row.status === 'pending') {
    await env.DB.prepare(
      "UPDATE bookings SET status='failed', updated_at=? WHERE id=?"
    ).bind(now, row.id).run();
  }

  return json({ ok: true });
}

/* ── ADMIN EMAIL (Resend) ───────────────────────────────────────── */
async function sendAdminEmail(env, booking) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) return;
  const rupees = (booking.amount / 100).toLocaleString('en-IN');
  const html = `
    <h2>New paid booking — VanThara Homestay</h2>
    <p><b>Guest:</b> ${escapeHtml(booking.guest_name)}<br/>
       <b>Phone:</b> ${escapeHtml(booking.phone)}<br/>
       <b>Email:</b> ${escapeHtml(booking.email || '—')}<br/>
       <b>Guests:</b> ${escapeHtml(String(booking.guests || '—'))}</p>
    <p><b>Check-in:</b> ${booking.checkin}<br/>
       <b>Check-out:</b> ${booking.checkout}<br/>
       <b>Nights:</b> ${booking.nights}</p>
    <p><b>Amount paid:</b> ₹${rupees}<br/>
       <b>Razorpay payment ID:</b> ${escapeHtml(booking.razorpay_payment_id || '—')}<br/>
       <b>Order ID:</b> ${escapeHtml(booking.razorpay_order_id || '—')}</p>
    <p>See the full list any time on the admin dashboard's Bookings tab.</p>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RESEND_API_KEY },
      body: JSON.stringify({
        from: 'Vanthara Bookings <onboarding@resend.dev>',
        to: [env.ADMIN_EMAIL],
        subject: `New booking paid: ${booking.checkin} → ${booking.checkout} (₹${rupees})`,
        html,
      }),
    });
  } catch (e) {
    // Don't fail the booking just because the email failed to send.
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ── STATS (for admin "test connection") ────────────────────────── */
async function getStats(env) {
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status='paid'").first();
  const upcoming = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE status='paid' AND checkout >= ?"
  ).bind(new Date().toISOString().slice(0, 10)).first();
  const revenue = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM bookings WHERE status='paid'").first();
  return { total_paid_bookings: total.n, upcoming_bookings: upcoming.n, total_revenue_rupees: Math.round(revenue.s / 100) };
}
