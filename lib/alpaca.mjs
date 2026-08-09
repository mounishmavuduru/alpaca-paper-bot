// Alpaca Trading API client: hardened fetch (timeout + retry with backoff),
// idempotent order placement via client_order_id, and the endpoints a daily
// cron bot actually needs (account, positions, OPEN ORDERS, clock, calendar).

const KEY = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;
export const BASE = process.env.ALPACA_BASE || 'https://paper-api.alpaca.markets';

// Interlock: pointing this bot at the LIVE endpoint must be a two-key turn.
if (BASE.includes('api.alpaca.markets') && !BASE.includes('paper') && process.env.I_UNDERSTAND_LIVE !== 'yes') {
  throw new Error('ALPACA_BASE is the LIVE endpoint. Set I_UNDERSTAND_LIVE=yes if you truly mean to trade real money.');
}

const HDRS = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET, 'Content-Type': 'application/json' };
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export async function req(method, path, body, { base = BASE, tries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const r = await fetch(base + path, {
        method,
        headers: HDRS,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) return r.status === 204 ? null : await r.json();
      const text = await r.text();
      const err = new Error(`${method} ${path} ${r.status} ${text.slice(0, 300)}`);
      err.status = r.status;
      err.body = text;
      if (!RETRYABLE.has(r.status)) throw err;
      lastErr = err;
    } catch (e) {
      if (e.status && !RETRYABLE.has(e.status)) throw e; // non-retryable HTTP error
      lastErr = e;                                       // network/timeout/5xx → retry
    }
    if (attempt < tries) await new Promise(res => setTimeout(res, 1500 * 2 ** (attempt - 1)));
  }
  throw lastErr;
}

export const getAccount = () => req('GET', '/v2/account');
export const getPositions = () => req('GET', '/v2/positions');
export const getOpenOrders = () => req('GET', '/v2/orders?status=open&limit=500');
export const getClock = () => req('GET', '/v2/clock');
export const cancelOrder = (id) => req('DELETE', `/v2/orders/${id}`);

// Recently-closed orders (for detecting async rejections: an order accepted in the
// evening can still be REJECTED at next-open fill time, invisibly to the placing run).
export const getClosedOrdersSince = (afterIso) =>
  req('GET', `/v2/orders?status=closed&limit=500&after=${encodeURIComponent(afterIso)}`);

// Is `dateET` (YYYY-MM-DD) a trading day? Uses the exchange calendar, not the runner clock.
export async function isTradingDay(dateET) {
  const cal = await req('GET', `/v2/calendar?start=${dateET}&end=${dateET}`);
  return Array.isArray(cal) && cal.length > 0 && cal[0].date === dateET;
}

// Today's date in exchange (ET) time, derived from Alpaca's clock — never the runner's TZ.
export async function todayET() {
  const clock = await getClock();
  const et = new Date(clock.timestamp).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return { date: et, is_open: clock.is_open };
}

// Idempotent order placement. A reused client_order_id makes Alpaca return 422
// "client order id must be unique" — we treat that as "already placed, skip",
// which makes re-runs (manual dispatch, retried jobs) safe by construction.
export async function placeOrder(order) {
  try {
    return { placed: true, order: await req('POST', '/v2/orders', order) };
  } catch (e) {
    if (e.status === 422 && /client.?order.?id.*unique|duplicate/i.test(e.body || '')) {
      return { placed: false, duplicate: true, order: null };
    }
    throw e;
  }
}
