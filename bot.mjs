// Alpaca PAPER trading bot — RSI-2 dip buyer. Runs daily on GitHub Actions (cloud, no laptop).
// Data: Yahoo (free, no auth). Broker: Alpaca (positions + orders). PAPER by default.
// SAFETY: starts in DRY_RUN (logs only, places nothing); position caps; kill switch; per-symbol
// error isolation. Flip DRY_RUN=false only when you're ready to place real (paper) orders.

const KEY = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;
const BASE = process.env.ALPACA_BASE || 'https://paper-api.alpaca.markets'; // PAPER endpoint by default
const DRY_RUN = (process.env.DRY_RUN ?? 'true') !== 'false';   // default ON (safe)
const KILL = (process.env.KILL_SWITCH ?? 'false') === 'true';
// Defaults = the ETF types the 528-market test showed the strategy LOVES (broad/intl/bond/commodity, all ~100% profitable).
const SYMBOLS = (process.env.SYMBOLS || 'SPY,QQQ,IWM,EEM,GLD,TLT').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const ALLOC_PCT = Number(process.env.ALLOC_PCT || '20') / 100;  // % of equity per position
const MAX_POSITIONS = Number(process.env.MAX_POSITIONS || '3'); // max concurrent holdings
// RESEARCH: the ML model's #1 predictor (40% of its weight) was SPY's own RSI-2 — dips bounce best when
// the whole market is ALSO oversold. SPY_MAX_RSI2 gates buys to those high-conviction windows.
// 100 = off (take every dip, the base strategy). Try 50 = only buy dips when SPY is also weak.
const SPY_MAX_RSI2 = Number(process.env.SPY_MAX_RSI2 || '100');

if (!KEY || !SECRET) { console.error('FATAL: missing ALPACA_KEY / ALPACA_SECRET.'); process.exit(1); }
if (KILL) { console.log('KILL_SWITCH=true — exiting without trading.'); process.exit(0); }

const HDRS = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET, 'Content-Type': 'application/json' };
const aGet = async (p) => { const r = await fetch(BASE + p, { headers: HDRS }); if (!r.ok) throw new Error(`GET ${p} ${r.status} ${await r.text()}`); return r.json(); };
const aPost = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: HDRS, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`POST ${p} ${r.status} ${await r.text()}`); return r.json(); };

function wilderRSI(c, p) { let g = 0, l = 0; for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); } g /= p; l /= p; for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); }
async function bars(sym) { const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2y`, { headers: { 'User-Agent': 'Mozilla/5.0' } }); const j = await r.json(); return j.chart.result[0].indicators.quote[0].close.filter(x => x != null); }

(async () => {
  console.log(`=== Alpaca RSI-2 bot ${DRY_RUN ? '[DRY RUN — placing nothing]' : '[LIVE PAPER — placing orders]'} ${new Date().toISOString()} ===`);
  const acct = await aGet('/v2/account');
  const equity = Number(acct.equity);
  console.log(`Account ${acct.status} | equity $${equity} | cash $${acct.cash} | base=${BASE}`);
  if (acct.trading_blocked || acct.account_blocked) { console.error('Account is blocked — not trading.'); process.exit(1); }
  const positions = await aGet('/v2/positions');
  const held = new Set(positions.map(p => p.symbol));
  console.log(`Holding: ${[...held].join(', ') || '(none)'} | ${held.size}/${MAX_POSITIONS} slots used`);
  // RESEARCH: broad-market regime — dips bounce best when SPY itself is also oversold.
  let spyRsi2 = null;
  try { spyRsi2 = wilderRSI(await bars('SPY'), 2); } catch {}
  console.log(`Market regime: SPY RSI-2 = ${spyRsi2 == null ? 'n/a' : spyRsi2.toFixed(0)}${spyRsi2 != null && spyRsi2 < 50 ? ' — market also oversold (high-conviction window 🔥)' : ''}\n`);

  for (const sym of SYMBOLS) {
    try {
      const c = await bars(sym);
      if (c.length < 200) { console.log(`${sym}: not enough data, skip`); continue; }
      const last = c[c.length - 1];
      const sma200 = c.slice(-200).reduce((a, b) => a + b, 0) / 200;
      const rsi2 = wilderRSI(c, 2);
      const haveIt = held.has(sym);
      const tag = `${sym} $${last.toFixed(2)} rsi2=${rsi2.toFixed(0)} ${last > sma200 ? 'uptrend' : 'downtrend'}`;
      const buy = !haveIt && last > sma200 && rsi2 < 5;
      const sell = haveIt && rsi2 > 65;

      if (buy) {
        if (spyRsi2 != null && spyRsi2 >= SPY_MAX_RSI2) { console.log(`${tag} → BUY signal, but market not weak enough (SPY RSI-2 ${spyRsi2.toFixed(0)} ≥ ${SPY_MAX_RSI2}) → skip`); continue; }
        if (held.size >= MAX_POSITIONS) { console.log(`${tag} → BUY signal, but ${MAX_POSITIONS} slots full → skip`); continue; }
        const qty = Math.floor((equity * ALLOC_PCT) / last);
        if (qty < 1) { console.log(`${tag} → BUY signal, but qty<1 (raise ALLOC_PCT) → skip`); continue; }
        if (DRY_RUN) console.log(`${tag} → 🟢 WOULD BUY ${qty} @ market`);
        else { await aPost('/v2/orders', { symbol: sym, qty, side: 'buy', type: 'market', time_in_force: 'day' }); console.log(`${tag} → 🟢 BUY ${qty} placed ✅`); held.add(sym); }
      } else if (sell) {
        const pos = positions.find(p => p.symbol === sym);
        if (DRY_RUN) console.log(`${tag} → 🔴 WOULD SELL ${pos.qty} @ market`);
        else { await aPost('/v2/orders', { symbol: sym, qty: Number(pos.qty), side: 'sell', type: 'market', time_in_force: 'day' }); console.log(`${tag} → 🔴 SELL ${pos.qty} placed ✅`); }
      } else {
        console.log(`${tag} → ${haveIt ? 'holding, no exit yet' : 'flat, no dip yet'}`);
      }
    } catch (e) { console.error(`${sym} ERROR: ${e.message}`); }
  }
  console.log('\n=== run complete ===');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
