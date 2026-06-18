// Sector-momentum ROTATION bot — monthly. Holds the top-N SPDR sectors by 12-month momentum
// (positive momentum only; cash otherwise). Validated in rotation_backtest.mjs: ~market return,
// HALF the drawdown, better Sharpe. Data: Yahoo. Broker: Alpaca paper. PAPER + DRY_RUN safe by default.

const KEY = process.env.ALPACA_KEY, SECRET = process.env.ALPACA_SECRET;
const BASE = process.env.ALPACA_BASE || 'https://paper-api.alpaca.markets';
const DRY_RUN = (process.env.DRY_RUN ?? 'true') !== 'false';
const KILL = (process.env.KILL_SWITCH ?? 'false') === 'true';
const SECTORS = (process.env.SECTORS || 'XLK,XLF,XLE,XLV,XLY,XLI,XLP,XLU,XLB,XLRE,XLC').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const TOP_N = Number(process.env.TOP_N || '3');

if (!KEY || !SECRET) { console.error('FATAL: missing ALPACA_KEY / ALPACA_SECRET.'); process.exit(1); }
if (KILL) { console.log('KILL_SWITCH=true — exiting without trading.'); process.exit(0); }

const HDRS = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET, 'Content-Type': 'application/json' };
const aGet = async (p) => { const r = await fetch(BASE + p, { headers: HDRS }); if (!r.ok) throw new Error(`GET ${p} ${r.status} ${await r.text()}`); return r.json(); };
const aPost = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: HDRS, body: JSON.stringify(b) }); if (!r.ok) throw new Error(`POST ${p} ${r.status} ${await r.text()}`); return r.json(); };
async function bars(sym) { const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2y`, { headers: { 'User-Agent': 'Mozilla/5.0' } }); const j = await r.json(); return j.chart.result[0].indicators.quote[0].close.filter(x => x != null); }

(async () => {
  console.log(`=== Sector Rotation bot ${DRY_RUN ? '[DRY RUN]' : '[LIVE PAPER]'} ${new Date().toISOString()} ===`);
  const acct = await aGet('/v2/account');
  const equity = Number(acct.equity);
  console.log(`Account ${acct.status} | equity $${equity}`);
  const positions = await aGet('/v2/positions');
  const heldMap = new Map(positions.map(p => [p.symbol, p]));

  // 12-month momentum per sector
  const ranked = [];
  for (const s of SECTORS) {
    try { const c = await bars(s); if (c.length < 252) continue; ranked.push({ s, mom: c[c.length - 1] / c[c.length - 252] - 1, price: c[c.length - 1] }); }
    catch (e) { console.error(`${s} data error: ${e.message}`); }
  }
  ranked.sort((a, b) => b.mom - a.mom);
  const target = ranked.filter(x => x.mom > 0).slice(0, TOP_N);   // positive-momentum top-N only
  const targetSet = new Set(target.map(x => x.s));
  console.log(`Ranked: ${ranked.map(x => `${x.s} ${(x.mom * 100).toFixed(0)}%`).join(', ')}`);
  console.log(`Target (top ${TOP_N}, positive only): ${[...targetSet].join(', ') || '(all cash — no positive momentum)'}\n`);

  // SELL anything held that's NOT in the target
  for (const [sym, pos] of heldMap) {
    if (targetSet.has(sym)) { console.log(`${sym} → keep (in target)`); continue; }
    if (DRY_RUN) console.log(`${sym} → 🔴 WOULD SELL ${pos.qty} (rotated out)`);
    else { await aPost('/v2/orders', { symbol: sym, qty: Number(pos.qty), side: 'sell', type: 'market', time_in_force: 'day' }); console.log(`${sym} → 🔴 SELL ${pos.qty} (rotated out) ✅`); }
  }
  // BUY target sectors not currently held, sized to equal weight
  const perSlot = equity / TOP_N;
  for (const t of target) {
    if (heldMap.has(t.s)) continue;
    const qty = Math.floor(perSlot / t.price);
    if (qty < 1) { console.log(`${t.s} → target but qty<1, skip`); continue; }
    if (DRY_RUN) console.log(`${t.s} → 🟢 WOULD BUY ${qty} (mom ${(t.mom * 100).toFixed(0)}%)`);
    else { await aPost('/v2/orders', { symbol: t.s, qty, side: 'buy', type: 'market', time_in_force: 'day' }); console.log(`${t.s} → 🟢 BUY ${qty} (mom ${(t.mom * 100).toFixed(0)}%) ✅`); }
  }
  console.log('\n=== rotation run complete ===');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
