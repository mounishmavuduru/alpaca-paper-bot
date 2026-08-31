// Sector-momentum ROTATION bot — monthly, hardened. Holds the top-N SPDR sectors by
// 12-1 momentum (12-month return skipping the most recent month — the academic
// standard; plain 12-0 gets whipsawed by short-term reversal), positive momentum only.
//
// Hardening over v1 (each fixes an incident observed in the June–Aug 2026 logs):
//  - ONLY manages symbols in its own SECTORS universe. v1 sold EVERY account position
//    not in its target — including the RSI bot's — every month.
//  - A sector with FAILED data is HELD, not sold: v1 treated "fetch error" as
//    "rotate out", selling positions over transient Yahoo failures.
//  - Per-symbol error isolation: v1 died mid-run on the first order error
//    (2026-08-01: crashed on a double-sell 403, then never bought its August targets —
//    the rotation sleeve sat empty all month with no alert).
//  - Open-order awareness + idempotent client_order_id: no double-sells (the 403 above
//    was v1 re-selling shares already held_for_orders by a queued RSI-bot sell).
//  - Buys are cash-budgeted (plus haircut sale proceeds from this run's own sells) —
//    v1 sized off raw equity and silently used margin.
//  - Dividend-adjusted bars: v1 ranked momentum on unadjusted closes, which understates
//    high-dividend sectors (measured 2026-08-07: XLU 12-mo momentum 0.8% raw vs 3.6% adjusted).

import { parseBool, parseNum, parseSymbols, assertDisjoint } from './lib/config.mjs';
import { momentum } from './lib/indicators.mjs';
import * as alpaca from './lib/alpaca.mjs';
import { getDailyBars } from './lib/data.mjs';
import { alert, note, flushSummary } from './lib/alerts.mjs';
import { appendRun, circuitCheck } from './lib/journal.mjs';

const DRY_RUN = parseBool('DRY_RUN_ROT', parseBool('DRY_RUN', true));
const KILL = parseBool('KILL_SWITCH_ROT', parseBool('KILL_SWITCH', false));
const SECTORS = parseSymbols('SECTORS', 'XLK,XLF,XLE,XLV,XLY,XLI,XLP,XLU,XLB,XLRE,XLC');
const SYMBOLS = parseSymbols('SYMBOLS', 'SPY,QQQ,DIA,IWM,VTI,MDY,SMH,SOXX,XBI,KRE,ITB,XOP,GDX,EEM,EFA,FXI,EWZ,TLT,IEF,HYG,GLD,SLV'); // RSI bot's turf
const TOP_N = parseNum('TOP_N', 3, { min: 1, max: 11 });
const MOM_SKIP = parseNum('MOM_SKIP', 21, { min: 0, max: 63 });  // 21 = 12-1 momentum; 0 = v1 behavior
const MOM_BLEND = parseBool('MOM_BLEND', false);                // rank on mean of 3m/6m/12-1m (specification-fragility hedge)
const ROT_ALLOC_PCT = parseNum('ROT_ALLOC_PCT', 90, { min: 10, max: 100 }) / 100; // % of equity the sleeve may use
const MAX_DRAWDOWN_PCT = parseNum('MAX_DRAWDOWN_PCT', 12, { min: 2, max: 90 });
const CIRCUIT_RESET = parseBool('CIRCUIT_RESET', false);
const ALLOW_INTRADAY = parseBool('ALLOW_INTRADAY', false);

const journal = { ts: new Date().toISOString(), bot: 'rotation', dry_run: DRY_RUN, orders: [], incidents: [] };

async function main() {
  console.log(`=== Rotation bot ${DRY_RUN ? '[DRY RUN — placing nothing]' : '[LIVE PAPER]'} ${journal.ts} ===`);
  if (KILL) { console.log(`${process.env.KILL_SWITCH_ROT?.trim() ? 'KILL_SWITCH_ROT' : 'KILL_SWITCH'}=true — exiting without trading.`); return; }
  assertDisjoint('SECTORS', SECTORS, 'SYMBOLS', SYMBOLS);

  const { date: today, is_open } = await alpaca.todayET();
  journal.date_et = today;
  journal.session = false; // monthly bot: never counts toward the RSI bot's trading-day math
  // Monthly cadence must not be skipped on a weekend 1st — Friday's close is a valid
  // monthly signal and queued orders fill at the next open. Only guard intraday runs.
  let dryRun = DRY_RUN;
  if (is_open && !ALLOW_INTRADAY && !dryRun) {
    await alert('warn', 'Market is open — forcing DRY RUN', 'Monthly signals use completed daily bars. Set ALLOW_INTRADAY=true to override.');
    dryRun = true;
  }
  journal.dry_run = dryRun;

  const acct = await alpaca.getAccount();
  const equity = Number(acct.equity);
  const cash = Number(acct.cash);
  journal.equity = equity; journal.cash = cash;
  console.log(`Account ${acct.status} | equity $${equity.toFixed(0)} | cash $${cash.toFixed(0)}`);
  if (!Number.isFinite(equity) || !Number.isFinite(cash)) {
    await alert('error', 'Account equity/cash unreadable — not trading', `equity='${acct.equity}' cash='${acct.cash}'`);
    process.exitCode = 1;
    return;
  }
  if (acct.trading_blocked || acct.account_blocked || acct.status !== 'ACTIVE') {
    await alert('error', 'Account blocked or not ACTIVE — not trading', `status=${acct.status}`);
    process.exitCode = 1;
    return;
  }

  const positions = await alpaca.getPositions();
  const openOrders = await alpaca.getOpenOrders();
  const mine = positions.filter(p => SECTORS.includes(p.symbol));          // ONLY my universe
  const ordersFor = (sym) => openOrders.filter(o => o.symbol === sym);
  console.log(`My sector positions: ${mine.map(p => p.symbol).join(', ') || '(none)'}`);

  const unmanaged = positions.filter(p => !SECTORS.includes(p.symbol) && !SYMBOLS.includes(p.symbol));
  if (unmanaged.length) {
    await alert('error', `UNMANAGED position(s): ${unmanaged.map(p => p.symbol).join(', ')}`,
      'In neither bot\'s universe: no exits, no stop-loss reconciliation, ever. Close them manually or add the symbol back to SYMBOLS/SECTORS.');
    process.exitCode = 1;
  }

  // Surface async order failures since the LAST monthly run (accepted → rejected at open);
  // a short window here would mean a rejection on the 2nd is never seen by a monthly bot.
  try {
    const closed = await alpaca.getClosedOrdersSince(new Date(Date.now() - 40 * 86_400_000).toISOString());
    for (const o of closed.filter(o => o.client_order_id?.startsWith('rot-') && ['rejected', 'expired'].includes(o.status))) {
      await alert('error', `Rotation order ${o.status} after acceptance: ${o.side} ${o.qty} ${o.symbol}`,
        `client_order_id=${o.client_order_id} — the rotation may be incomplete; re-run via workflow_dispatch after checking.`);
      process.exitCode = 1;
    }
  } catch (e) { journal.incidents.push(`closed-order check: ${e.message}`); }

  // --- circuit breaker (shared state with the RSI bot): a deep account drawdown halts
  // rotation BUYS too; sells/rebalancing-out still run. ---
  const circuit = circuitCheck(equity, MAX_DRAWDOWN_PCT, { reset: CIRCUIT_RESET });
  journal.circuit = circuit;
  if (circuit.tripped) await alert('error', `CIRCUIT BREAKER: drawdown ${circuit.ddPct.toFixed(1)}% from peak — rotation buys halted`);

  // --- rank by 12-1 momentum on adjusted closes. Symbols with queued BUY orders (the
  // RSI bot's included) are fetched separately so the cash budget can price them. ---
  const MIN_BARS = 253 + MOM_SKIP;
  const { bars, failures } = await getDailyBars(SECTORS, MIN_BARS);
  const priceOnly = [...new Set(openOrders.filter(o => o.side === 'buy').map(o => o.symbol))].filter(s => !bars.has(s));
  if (priceOnly.length) {
    const extra = await getDailyBars(priceOnly, 2);
    for (const [k, v] of extra.bars) bars.set(k, v);
  }
  const failed = new Set(failures.map(f => f.sym));
  for (const f of failures) journal.incidents.push(`data: ${f.sym}: ${f.error}`);

  // Stale series (>7 calendar days old) are as untrustworthy as missing ones: hold, don't rank.
  // Anchored to the broker's ET session date, like every other date in this bot — the
  // runner's wall clock is a different clock and need not agree with the market's.
  const staleBefore = new Date(new Date(`${today}T12:00:00Z`).getTime() - 7 * 86_400_000)
    .toISOString().slice(0, 10);
  const ranked = [];
  for (const s of SECTORS) {
    const rec = bars.get(s);
    if (!rec || rec.closes.length < MIN_BARS) { failed.add(s); continue; }
    if (rec.lastDate && rec.lastDate < staleBefore) { failed.add(s); journal.incidents.push(`stale data: ${s} last bar ${rec.lastDate}`); continue; }
    const mom = MOM_BLEND
      ? (momentum(rec.closes, 63) + momentum(rec.closes, 126) + momentum(rec.closes, 252, MOM_SKIP)) / 3
      : momentum(rec.closes, 252, MOM_SKIP);
    ranked.push({ s, mom, price: rec.closes.at(-1), source: rec.source });
  }
  ranked.sort((a, b) => b.mom - a.mom);
  const target = ranked.filter(x => x.mom > 0).slice(0, TOP_N);
  const targetSet = new Set(target.map(x => x.s));
  console.log(`Ranked (12-${MOM_SKIP ? '1' : '0'} momentum): ${ranked.map(x => `${x.s} ${(x.mom * 100).toFixed(0)}%`).join(', ')}`);
  if (failed.size) console.log(`No data (will NOT be sold on this basis): ${[...failed].join(', ')}`);
  console.log(`Target (top ${TOP_N}, positive only): ${[...targetSet].join(', ') || '(all cash — no positive momentum)'}\n`);
  journal.target = [...targetSet];

  if (failed.size > 0 && ranked.length < SECTORS.length - 2) {
    await alert('error', `Rotation aborted: too many data failures (${failed.size}/${SECTORS.length})`,
      'Ranking would be meaningless. Holding current positions.');
    process.exitCode = 1;
    return;
  }

  const place = async (order, describe) => {
    if (dryRun) { console.log(`   → WOULD ${describe}`); return; }
    const res = await alpaca.placeOrder(order);
    if (res.duplicate) console.log(`   → already placed today (client_order_id dedupe): ${describe}`);
    else { console.log(`   → ${describe} ✅`); journal.orders.push(order); await alert('order', describe); }
  };

  // --- SELL held sectors that fell out of the target (never on data failure) ---
  let saleProceeds = 0;
  for (const pos of mine) {
    const sym = pos.symbol;
    try {
      if (targetSet.has(sym)) { console.log(`${sym} → keep (in target)`); continue; }
      if (failed.has(sym)) {
        // Held + no data: hold (never sell on a data error) but say so out loud — silence
        // here would break the "data failures are never a silent skip" guarantee.
        await alert('warn', `No data for held sector ${sym} — HOLDING (not a rotation decision)`,
          failures.find(f => f.sym === sym)?.error ?? 'insufficient history');
        continue;
      }
      if (ordersFor(sym).some(o => o.side === 'sell' && !['stop', 'stop_limit', 'trailing_stop'].includes(o.type))) { console.log(`${sym} → sell already queued, skip`); continue; }
      for (const o of ordersFor(sym)) {
        if (dryRun) { console.log(`${sym} → WOULD cancel open ${o.type} order first`); continue; }
        const st = await alpaca.cancelAndWait(o.id);
        if (!alpaca.FREED.has(st)) throw new Error(`open ${o.type} order ${o.id} ended '${st}' — shares not free, not selling ${sym}`);
        console.log(`${sym} → canceled open ${o.type} order ${o.id.slice(0, 8)}…`);
      }
      await place(
        { symbol: sym, qty: pos.qty, side: 'sell', type: 'market', time_in_force: 'day', client_order_id: `rot-sell-${sym}-${today}` },
        `SELL ${pos.qty} ${sym} @ market (rotated out)`,
      );
      const estPx = bars.get(sym)?.closes.at(-1) ?? Number(pos.current_price);
      if (Number.isFinite(estPx)) saleProceeds += Number(pos.qty) * estPx;
    } catch (e) {
      journal.incidents.push(`${sym}: ${e.message}`);
      await alert('error', `Rotation: ${sym} sell failed`, e.message);
      process.exitCode = 1;
    }
  }

  // --- BUY target sectors not held. Budget = cash − queued buys + haircut proceeds.
  // A queued buy we cannot price zeroes the cash portion (conservative). ---
  let budget = Math.max(0, cash);
  for (const o of openOrders.filter(o => o.side === 'buy')) {
    const est = o.notional ? Number(o.notional)
      : Number(o.limit_price || 0) > 0 ? Number(o.qty) * Number(o.limit_price)
      : Number(o.qty) * (bars.get(o.symbol)?.closes.at(-1) ?? NaN);
    if (Number.isFinite(est)) budget -= est;
    else { journal.incidents.push(`unpriceable queued buy ${o.symbol} — cash budget zeroed`); budget = 0; }
  }
  budget = Math.max(0, budget) + saleProceeds * 0.98; // 2% haircut for overnight gap on unfilled sells
  const perSlot = (equity * ROT_ALLOC_PCT) / TOP_N;

  for (const t of target) {
    try {
      if (mine.some(p => p.symbol === t.s)) continue;
      if (circuit.tripped) { console.log(`${t.s} → target, but circuit breaker tripped → no new buys`); continue; }
      if (ordersFor(t.s).some(o => o.side === 'buy')) { console.log(`${t.s} → buy already queued, skip`); continue; }
      const notional = Math.min(perSlot, budget);
      const qty = Math.floor(notional / t.price);
      if (qty < 1) {
        // Both sleeves draw on one cash pool, so whichever bot runs first can starve the
        // other. Silence here would leave the rotation sleeve empty for a month unnoticed.
        await alert('warn', `Rotation target ${t.s} UNFUNDED — only $${budget.toFixed(0)} cash available`,
          'The dip-buyer sleeve is holding the cash. Lower ALLOC_PCT/MAX_POSITIONS or ROT_ALLOC_PCT so both sleeves fit in 100% of equity.');
        continue;
      }
      const spend = qty * t.price;
      if (!(spend > 0 && spend <= (equity * ROT_ALLOC_PCT) / TOP_N * 1.05)) throw new Error(`sanity: order notional $${spend.toFixed(0)} out of bounds`);
      await place(
        { symbol: t.s, qty: String(qty), side: 'buy', type: 'market', time_in_force: 'day', client_order_id: `rot-buy-${t.s}-${today}` },
        `BUY ${qty} ${t.s} (~$${(qty * t.price).toFixed(0)}, mom ${(t.mom * 100).toFixed(0)}%)`,
      );
      budget -= qty * t.price;
    } catch (e) {
      journal.incidents.push(`${t.s}: ${e.message}`);
      await alert('error', `Rotation: ${t.s} buy failed`, e.message);
      process.exitCode = 1;
    }
  }

  journal.positions = mine.map(p => ({ sym: p.symbol, qty: p.qty, entry: p.avg_entry_price }));
  note(`equity **$${equity.toFixed(0)}** | target: ${[...targetSet].join(', ') || 'cash'} | orders placed: ${journal.orders.length}`);
  console.log('\n=== rotation run complete ===');
}

main()
  .catch(async e => {
    journal.incidents.push(`FATAL: ${e.message}`);
    await alert('error', 'Rotation bot FATAL', e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try { appendRun(journal); } catch (e) { console.error(`journal write failed: ${e.message}`); }
    flushSummary(`Rotation bot — ${journal.date_et ?? journal.ts}`);
  });
