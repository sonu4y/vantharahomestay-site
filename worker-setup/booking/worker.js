/**
* VANTHARA BOOKING AND PAYMENTS - Cloudflare Worker
* The backend for online booking and payment on vantharahomestay.com.
* Guests pick dates on the site, pay via Razorpay (cards, UPI, netbanking,
* wallets), and you get an email and see the booking on the admin
* dashboard's "Bookings" tab. No card details ever touch this Worker;
* Razorpay's Checkout handles that, and we only verify a signature after.
*
* Endpoints:
* GET /api/availability public, list of booked nights + live per-night rates
* POST /api/create-order public, checkin/checkout/name/email/phone/guests
* POST /api/verify-payment public, booking_id + razorpay fields
* POST /api/razorpay-webhook Razorpay only (signature-checked)
* GET /api/bookings admin (X-Admin-Key header)
* POST /api/bookings/:id/cancel admin (X-Admin-Key header)
* GET /api/me admin, quick stats for test connection
*/

/* ═══════════════════════════════════════════════════════════════
* PRICING CONFIG — DYNAMIC, DEMAND-BASED — EDIT THESE TABLES
*
* Benchmarked against comparable branded whole-villa rentals in
* Hyderabad (SaffronStays / StayVista-style 4-6BHK villas with pool,
* farmhouses near Shamshabad, Airbnb/Goibibo listings), which run
* roughly Rs.15,000-25,000+/night for a villa this size and class.
* Vanthara's rate is built from five layers, same idea as how those
* platforms price, just transparent and editable here:
*
* 1. SEASON  — Hyderabad's weather + wedding/festival calendar
* 2. WEEKEND — Friday/Saturday night uplift
* 3. FESTIVAL — named high-demand dates override the season rate
* 4. SURGE   — if YOUR OWN calendar is filling up fast in the next
* 45 days, remaining nights get a real demand-based bump.
* (This uses your actual bookings, not scraped competitor
* prices — live scraping of Airbnb/Booking.com is unreliable
* and against those platforms' terms, so it isn't used here.)
* 5. GUEST COUNT — a flat per-night fee for larger groups (11-15
* and 16+), reflecting the extra linens, cleaning, water and
* electricity a full house actually costs to run. Groups of
* 1-10 pay the base rate with no surcharge.
*
* Add next year's festival dates every Jan/Feb once the official
* calendar is published (drikpanchang.com or the govt. gazette).
* ═══════════════════════════════════════════════════════════════ */
const CURRENCY = 'INR';
const WEEKEND_DAYS = [5, 6]; // Fri, Sat nights (UTC day-of-week: 0=Sun...6=Sat)

// Season tier by calendar month (1 = Jan ... 12 = Dec)
//   PEAK     Oct-Feb: best weather, wedding season, festival cluster
//   SHOULDER Mar, Jun-Sep: moderate demand
//   OFF      Apr-May: peak summer heat, lowest demand
const SEASON_BY_MONTH = {
  1: 'PEAK', 2: 'PEAK', 3: 'SHOULDER', 4: 'OFF', 5: 'OFF',
  6: 'SHOULDER', 7: 'SHOULDER', 8: 'SHOULDER', 9: 'SHOULDER',
  10: 'PEAK', 11: 'PEAK', 12: 'PEAK',
};

const SEASON_RATES = {
  OFF: { weekday: 12000, weekend: 15000 },
  SHOULDER: { weekday: 13500, weekend: 17500 },
  PEAK: { weekday: 16500, weekend: 21500 },
};

// Fixed-date festivals / long weekends — same MM-DD every year, so
// these apply automatically forever. Flat rate per night, used
// whenever it's HIGHER than the season/weekend rate for that date.
const FESTIVAL_WINDOWS = [
  { from: '12-30', to: '01-01', rate: 28000, label: 'New Year' },
  { from: '12-24', to: '12-26', rate: 24000, label: 'Christmas' },
  { from: '01-13', to: '01-15', rate: 20000, label: 'Sankranti' },
  { from: '01-25', to: '01-26', rate: 19000, label: 'Republic Day weekend' },
  { from: '08-14', to: '08-16', rate: 18000, label: 'Independence Day weekend' },
];

// Lunar / movable festivals — exact dates, confirmed for 2026.
// ADD NEXT YEAR'S DATES HERE once published — search
// "India public holidays <year>" or drikpanchang.com.
const FESTIVAL_DATES_EXACT = [
  { from: '2026-03-02', to: '2026-03-03', rate: 18000, label: 'Holi' },
  { from: '2026-10-19', to: '2026-10-21', rate: 20000, label: 'Dussehra' },
  { from: '2026-11-07', to: '2026-11-10', rate: 24000, label: 'Diwali' },
  { from: '2026-11-23', to: '2026-11-24', rate: 17000, label: 'Guru Nanak Jayanti' },
];

// Occupancy-based demand surge, computed live from real bookings in
// the next 45 days. Higher tiers checked first.
const SURGE_TIERS = [
  { minOccupancy: 0.65, multiplier: 1.15 },
  { minOccupancy: 0.40, multiplier: 1.08 },
];

// Extra-guest fee — flat Rs./night, on top of the dynamic rate above.
// Matched against the start of the "guests" string sent by the site's
// booking form ("1–5", "6–10", "11–15", "16+"). 1-10 guests: no fee.
const GUEST_SURCHARGE_TIERS = [
  { prefix: '16', perNight: 3500 },
  { prefix: '11', perNight: 2000 },
];
function guestSurchargePerNight(guestsStr) {
  const g = String(guestsStr || '').trim();
  for (const tier of GUEST_SURCHARGE_TIERS) {
    if (g.startsWith(tier.prefix)) return tier.perNight;
  }
  return 0;
}

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

      if (url.pathname === '/api/availability' && request.method === 'GET') {
        const nightsArr = await getBlockedNights(env);
        const blockedSet = new Set(nightsArr);
        const occupancy = occupancyRatio(blockedSet);
        const surge = surgeMultiplier(occupancy);
        const rates = {};
        let cur = new Date().toISOString().slice(0, 10);
        for (let i = 0; i < 400; i++) {
          rates[cur] = nightRate(cur, surge);
          cur = addDays(cur, 1);
        }
        return json({ blocked: nightsArr, rates, occupancy_next_45d_pct: Math.round(occupancy * 100) });
      }

      if (url.pathname === '/api/create-order' && request.method === 'POST') {
        return await handleCreateOrder(request, env, json);
      }

      if (url.pathname === '/api/verify-payment' && request.method === 'POST') {
        return await handleVerifyPayment(request, env, json);
      }

      if (url.pathname === '/api/razorpay-webhook' && request.method === 'POST') {
        return await handleWebhook(request, env, json);
      }

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

/* SCHEMA */
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

/* PRICING */
function seasonRate(dateStr) {
  const month = Number(dateStr.slice(5, 7));
  const day = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  const tier = SEASON_BY_MONTH[month] || 'SHOULDER';
  const isWeekend = WEEKEND_DAYS.includes(day);
  return isWeekend ? SEASON_RATES[tier].weekend : SEASON_RATES[tier].weekday;
}

// Handles MM-DD ranges that wrap the New Year boundary (e.g. 12-30 to 01-01)
function inMMDDRange(mmdd, from, to) {
  if (from <= to) return mmdd >= from && mmdd <= to;
  return mmdd >= from || mmdd <= to;
}

function festivalRate(dateStr) {
  const mmdd = dateStr.slice(5, 10);
  let best = 0;
  for (const w of FESTIVAL_WINDOWS) {
    if (inMMDDRange(mmdd, w.from, w.to)) best = Math.max(best, w.rate);
  }
  for (const w of FESTIVAL_DATES_EXACT) {
    if (dateStr >= w.from && dateStr <= w.to) best = Math.max(best, w.rate);
  }
  return best;
}

function occupancyRatio(blockedSet) {
  const today = new Date().toISOString().slice(0, 10);
  const horizon = addDays(today, 45);
  let bookedInWindow = 0, totalNights = 0;
  let cur = today;
  while (cur < horizon) {
    totalNights++;
    if (blockedSet.has(cur)) bookedInWindow++;
    cur = addDays(cur, 1);
  }
  return totalNights ? bookedInWindow / totalNights : 0;
}

function surgeMultiplier(occupancy) {
  for (const tier of SURGE_TIERS) {
    if (occupancy >= tier.minOccupancy) return tier.multiplier;
  }
  return 1;
}

function roundToNearest500(n) {
  return Math.round(n / 500) * 500;
}

function nightRate(dateStr, surge) {
  const season = seasonRate(dateStr);
  const festival = festivalRate(dateStr);
  if (festival > season) return roundToNearest500(festival);
  return roundToNearest500(season * surge);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function computeQuote(checkin, checkout, surge, guestsStr) {
  const nights = [];
  let cur = checkin;
  while (cur < checkout) {
    nights.push({ date: cur, rate: nightRate(cur, surge) });
    cur = addDays(cur, 1);
  }
  const baseTotal = nights.reduce((s, n) => s + n.rate, 0);
  const guestFeePerNight = guestSurchargePerNight(guestsStr);
  const guestFeeTotal = guestFeePerNight * nights.length;
  const total = baseTotal + guestFeeTotal;
  return {
    nights: nights.length,
    breakdown: nights,
    baseTotalRupees: baseTotal,
    guestFeePerNight,
    guestFeeTotal,
    totalRupees: total,
    amountPaise: total * 100,
  };
}

/* AVAILABILITY */
async function getBlockedNights(env) {
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

/* CREATE ORDER */
async function handleCreateOrder(request, env, json) {
  const body = await request.json().catch(() => ({}));
  const { checkin, checkout, name, email, phone, guests } = body;

  if (!checkin || !checkout || !/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout)) {
    return json({ error: 'Valid checkin and checkout dates are required' }, 400);
  }
  if (checkout <= checkin) return json({ error: 'Check-out must be after check-in' }, 400);
  const today = new Date().toISOString().slice(0, 10);
  if (checkin < today) return json({ error: 'Check-in date is in the past' }, 400);
  if (!name || !phone) return json({ error: 'Name and phone are required' }, 400);

  const blockedSet = new Set(await getBlockedNights(env));
  let curCheck = checkin;
  while (curCheck < checkout) {
    if (blockedSet.has(curCheck)) {
      return json({ error: 'Sorry, those dates just got booked. Please pick different dates.' }, 409);
    }
    curCheck = addDays(curCheck, 1);
  }

  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    return json({ error: 'Payments are not configured yet on the server. Please contact the host directly.' }, 500);
  }

  const surge = surgeMultiplier(occupancyRatio(blockedSet));
  const quote = computeQuote(checkin, checkout, surge, guests);
  const receipt = 'vt_' + Date.now();

  const auth = btoa(env.RAZORPAY_KEY_ID + ':' + env.RAZORPAY_KEY_SECRET);
  const orderRes = await fetch(RAZORPAY_API + '/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
    body: JSON.stringify({
      amount: quote.amountPaise,
      currency: CURRENCY,
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
  ).bind(name, email || '', phone, guests || '', checkin, checkout, quote.nights, quote.amountPaise, CURRENCY, order.id, now, now).run();

  return json({
    booking_id: insert.meta.last_row_id,
    order_id: order.id,
    amount: quote.amountPaise,
    currency: CURRENCY,
    key_id: env.RAZORPAY_KEY_ID,
    nights: quote.nights,
    total_rupees: quote.totalRupees,
  });
}

/* VERIFY PAYMENT */
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

/* RAZORPAY WEBHOOK (backup confirmation path) */
async function handleWebhook(request, env, json) {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Razorpay-Signature') || '';

  if (!env.RAZORPAY_WEBHOOK_SECRET) return json({ ok: false }, 500);
  const expected = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, rawBody);
  if (expected !== signature) return json({ ok: false, error: 'Bad signature' }, 400);

  const evt = JSON.parse(rawBody);
  const entity = evt && evt.payload && evt.payload.payment && evt.payload.payment.entity;
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

/* ADMIN EMAIL (Resend) */
async function sendAdminEmail(env, booking) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) return;
  const rupees = (booking.amount / 100).toLocaleString('en-IN');
  const html = '<h2>New paid booking - VanThara Homestay</h2>' +
    '<p><b>Guest:</b> ' + escapeHtml(booking.guest_name) + '<br/>' +
    '<b>Phone:</b> ' + escapeHtml(booking.phone) + '<br/>' +
    '<b>Email:</b> ' + escapeHtml(booking.email || '-') + '<br/>' +
    '<b>Guests:</b> ' + escapeHtml(String(booking.guests || '-')) + '</p>' +
    '<p><b>Check-in:</b> ' + booking.checkin + '<br/>' +
    '<b>Check-out:</b> ' + booking.checkout + '<br/>' +
    '<b>Nights:</b> ' + booking.nights + '</p>' +
    '<p><b>Amount paid:</b> Rs.' + rupees + '<br/>' +
    '<b>Razorpay payment ID:</b> ' + escapeHtml(booking.razorpay_payment_id || '-') + '<br/>' +
    '<b>Order ID:</b> ' + escapeHtml(booking.razorpay_order_id || '-') + '</p>' +
    "<p>See the full list any time on the admin dashboard's Bookings tab.</p>";
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RESEND_API_KEY },
      body: JSON.stringify({
        from: 'Vanthara Bookings <onboarding@resend.dev>',
        to: [env.ADMIN_EMAIL],
        subject: 'New booking paid: ' + booking.checkin + ' to ' + booking.checkout + ' (Rs.' + rupees + ')',
        html,
      }),
    });
  } catch (e) {
    // Don't fail the booking just because the email failed to send.
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c];
  });
}

/* STATS (for admin test connection) */
async function getStats(env) {
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status='paid'").first();
  const upcoming = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE status='paid' AND checkout >= ?"
  ).bind(new Date().toISOString().slice(0, 10)).first();
  const revenue = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM bookings WHERE status='paid'").first();
  return { total_paid_bookings: total.n, upcoming_bookings: upcoming.n, total_revenue_rupees: Math.round(revenue.s / 100) };
}
