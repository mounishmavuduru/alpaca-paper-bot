// In-process mock of the Alpaca trading API + market-data API + Yahoo chart API.
// Scenario tests run the REAL bots as child processes pointed here via env overrides.
import http from 'node:http';

const OPEN_STATUSES = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'held']);

export function startMock(state) {
  // state: { account, positions[], orders[], calendar[], clock, bars: {SYM: closes[]}, barDate }
  state.requests = [];
  let orderSeq = 0;

  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      state.requests.push(`${req.method} ${path}`);
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(obj === null ? '' : JSON.stringify(obj));
      };

      if (req.method === 'GET' && path === '/v2/account') return send(state.account);
      if (req.method === 'GET' && path === '/v2/positions') return send(state.positions);
      if (req.method === 'GET' && path === '/v2/clock') return send(state.clock);
      if (req.method === 'GET' && path === '/v2/calendar') return send(state.calendar);

      if (req.method === 'GET' && path === '/v2/orders:by_client_order_id') {
        const coid = url.searchParams.get('client_order_id');
        const o = state.orders.find(x => x.client_order_id === coid);
        return o ? send(o) : send({ message: 'order not found' }, 404);
      }
      if (req.method === 'GET' && path === '/v2/orders') {
        const status = url.searchParams.get('status') || 'open';
        const match = (o) => status === 'all' ? true
          : status === 'open' ? OPEN_STATUSES.has(o.status)
          : !OPEN_STATUSES.has(o.status);
        return send(state.orders.filter(match));
      }
      if (req.method === 'POST' && path === '/v2/orders') {
        const o = JSON.parse(body);
        // Optional injected broker rejections: [{symbol, side, type?, status, message}]
        const reject = (state.rejectOrders || []).find(r =>
          r.symbol === o.symbol && r.side === o.side && (!r.type || r.type === o.type));
        if (reject) return send({ message: reject.message || 'rejected', code: 40310000 }, reject.status || 403);
        if (o.client_order_id && state.orders.some(x => x.client_order_id === o.client_order_id)) {
          return send({ message: 'client order id must be unique' }, 422);
        }
        const rec = { id: `ord_${++orderSeq}`, status: 'new', ...o };
        state.orders.push(rec);
        // Optional: simulate an order that LANDS but whose response is lost (503), which
        // is what makes a blind client-side retry dangerous.
        if (state.loseFirstOrderResponse) {
          state.loseFirstOrderResponse = false;
          return send({ message: 'service unavailable' }, 503);
        }
        return send(rec);
      }
      if (req.method === 'GET' && path.startsWith('/v2/orders/')) {
        const id = path.split('/').pop();
        const o = state.orders.find(x => x.id === id);
        if (!o) return send({ message: 'order not found' }, 404);
        const snapshot = { ...o };
        if (o.status === 'pending_cancel') o.status = 'canceled'; // async cancel completes after one poll
        return send(snapshot);
      }
      if (req.method === 'DELETE' && path.startsWith('/v2/orders/')) {
        const id = path.split('/').pop();
        const o = state.orders.find(x => x.id === id);
        if (!o) return send({ message: 'order not found' }, 404);
        // Optional: simulate an order that FILLS in the race between our snapshot and our
        // cancel — terminal, but the shares are gone rather than freed.
        o.status = state.fillOnCancel?.includes(id) ? 'filled' : 'pending_cancel';
        return send(null, 204);
      }

      // Market-data API (Alpaca): batch daily bars
      if (req.method === 'GET' && path === '/v2/stocks/bars') {
        const syms = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
        const bars = {};
        for (const s of syms) {
          if (state.bars[s]) {
            bars[s] = state.bars[s].map((c, i) => ({
              t: `${dateNDaysBefore(state.barDate, state.bars[s].length - 1 - i)}T05:00:00Z`,
              c,
            }));
          }
        }
        return send({ bars, next_page_token: null });
      }

      // Yahoo chart API fallback — always fails in tests (mock bars are the only source)
      if (path.startsWith('/v8/finance/chart/')) {
        return send({ chart: { result: null, error: { code: 'Not Found', description: 'mock' } } }, 404);
      }

      send({ message: `mock: unhandled ${req.method} ${path}` }, 404);
    });
  });

  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}

// Calendar-date string N days before dateStr (YYYY-MM-DD). Calendar days are fine here:
// only the LAST bar's date matters to the bots (freshness), earlier dates are cosmetic.
function dateNDaysBefore(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---- synthetic close series with controllable signals ----

// Uptrend then a sharp 2-day dip: close > SMA200 and RSI-2 ≈ 0 (buy signal).
export function dipSeries(n = 250) {
  const c = [100];
  for (let i = 1; i < n - 2; i++) c.push(c[i - 1] * 1.0015);
  c.push(c[c.length - 1] * 0.97);
  c.push(c[c.length - 1] * 0.97);
  return c.map(x => Math.round(x * 100) / 100);
}

// Steady riser: RSI-2 = 100 (bounce/sell signal for a held position), well above SMA200.
export function bounceSeries(n = 250) {
  const c = [100];
  for (let i = 1; i < n; i++) c.push(c[i - 1] * 1.0012);
  return c.map(x => Math.round(x * 100) / 100);
}

// Uptrend with one mild down day: no dip (RSI-2 too high to buy), no bounce, no trend break.
export function holdSeries(n = 250) {
  const c = bounceSeries(n - 1);
  c.push(Math.round(c[c.length - 1] * 0.995 * 100) / 100);
  return c;
}

// Long downtrend: close far below SMA200 (trend-break exit for a held position).
export function downtrendSeries(n = 250) {
  const c = [100];
  for (let i = 1; i < n; i++) c.push(c[i - 1] * 0.9985);
  return c.map(x => Math.round(x * 1000) / 1000);
}

export function defaultState(overrides = {}) {
  const barDate = '2026-08-07';
  return {
    account: { status: 'ACTIVE', equity: '100000', cash: '100000', trading_blocked: false, account_blocked: false },
    positions: [],
    orders: [],
    calendar: [{ date: barDate }],
    clock: { timestamp: `${barDate}T22:00:00-04:00`, is_open: false, next_open: '', next_close: '' },
    bars: {},
    barDate,
    ...overrides,
  };
}
