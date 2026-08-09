// Daily-bar data layer. Signals need SPLIT+DIVIDEND-ADJUSTED closes — unadjusted
// closes fake out every indicator (measured on 2026-08-07: HYG 12-mo momentum was
// -0.7% unadjusted vs +5.2% adjusted; ex-dividend drops read as RSI "dips").
//
// Source order:
//   1. Alpaca Market Data batch bars (adjustment=all), feed from DATA_FEED (default
//      'sip' — free plan allows SIP history older than 15 min; falls back to 'iex'
//      on 403 subscription errors)
//   2. Yahoo v8 chart per symbol, using the adjclose series
// Every fetch has timeout + retries. Callers decide what to do about symbols that
// still have no data (the bots treat missing data on a HELD symbol as an incident,
// never a silent skip).

const KEY = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;
const DATA_BASE = process.env.ALPACA_DATA_BASE || 'https://data.alpaca.markets';
const YAHOO_BASE = process.env.YAHOO_BASE || 'https://query1.finance.yahoo.com';
const FEED = (process.env.DATA_FEED || 'sip').toLowerCase();

async function fetchJson(url, headers, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (r.ok) return await r.json();
      const text = await r.text();
      const err = new Error(`GET ${url.slice(0, 120)} ${r.status} ${text.slice(0, 200)}`);
      err.status = r.status;
      if (r.status < 500 && r.status !== 429 && r.status !== 408) throw err;
      lastErr = err;
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429 && e.status !== 408) throw e;
      lastErr = e;
    }
    if (attempt < tries) await new Promise(res => setTimeout(res, 1500 * 2 ** (attempt - 1)));
  }
  throw lastErr;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// Alpaca batch bars → Map<sym, {closes: number[], lastDate: 'YYYY-MM-DD'}>
async function alpacaBars(symbols, feed) {
  const out = new Map(symbols.map(s => [s, { closes: [], lastDate: null }]));
  const hdrs = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET };
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const url = `${DATA_BASE}/v2/stocks/bars?symbols=${symbols.join(',')}` +
      `&timeframe=1Day&start=${isoDaysAgo(800)}&adjustment=all&feed=${feed}` +
      `&limit=10000&sort=asc${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
    const j = await fetchJson(url, hdrs);
    for (const [sym, bars] of Object.entries(j.bars || {})) {
      const rec = out.get(sym);
      if (!rec) continue;
      for (const b of bars) {
        if (b.c != null && Number.isFinite(b.c)) {
          rec.closes.push(b.c);
          rec.lastDate = b.t.slice(0, 10);
        }
      }
    }
    pageToken = j.next_page_token;
    if (!pageToken) break;
  }
  return out;
}

// Yahoo fallback, one symbol — uses ADJCLOSE, not close.
async function yahooBars(sym) {
  const j = await fetchJson(
    `${YAHOO_BASE}/v8/finance/chart/${sym}?interval=1d&range=2y`,
    { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  );
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`Yahoo: no chart data for ${sym} (${JSON.stringify(j?.chart?.error || j).slice(0, 150)})`);
  const adj = res.indicators?.adjclose?.[0]?.adjclose;
  const raw = res.indicators?.quote?.[0]?.close;
  const series = adj || raw;
  if (!series) throw new Error(`Yahoo: no price series for ${sym}`);
  const ts = res.timestamp || [];
  const closes = [];
  let lastDate = null;
  for (let i = 0; i < series.length; i++) {
    if (series[i] != null && Number.isFinite(series[i])) {
      closes.push(series[i]);
      if (ts[i]) lastDate = new Date(ts[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    }
  }
  return { closes, lastDate, source: adj ? 'yahoo-adj' : 'yahoo-RAW' };
}

// Public API. Returns { bars: Map<sym, {closes, lastDate, source}>, failures: [{sym, error}] }
export async function getDailyBars(symbols) {
  const bars = new Map();
  const failures = [];
  let remaining = [...symbols];

  if (KEY && SECRET && process.env.DATA_SKIP_ALPACA !== 'true') {
    for (const feed of FEED === 'iex' ? ['iex'] : [FEED, 'iex']) {
      try {
        const got = await alpacaBars(remaining, feed);
        for (const [sym, rec] of got) {
          if (rec.closes.length > 0) bars.set(sym, { ...rec, source: `alpaca-${feed}` });
        }
        remaining = remaining.filter(s => !bars.has(s));
        break;
      } catch (e) {
        if (e.status === 403 && feed !== 'iex') { console.log(`data: feed=${feed} not permitted, retrying with iex`); continue; }
        console.error(`data: alpaca bars failed (${e.message}) — falling back to Yahoo`);
        break;
      }
    }
  }

  for (const sym of remaining) {
    try {
      bars.set(sym, await yahooBars(sym));
    } catch (e) {
      failures.push({ sym, error: e.message });
    }
  }
  return { bars, failures };
}

// A symbol's data is fresh if its last bar is the most recent completed trading day.
export function isFresh(rec, expectedDate) {
  return rec?.lastDate === expectedDate;
}
