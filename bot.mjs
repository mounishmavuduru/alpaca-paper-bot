// Alpaca PAPER trading bot — RSI-2 dip buyer, hardened.
//
// Strategy: buy when close > 200-SMA and RSI-2 < BUY_RSI2; exit on RSI-2 > SELL_RSI2
// (or close > 5-SMA with EXIT_MODE=sma5), a trend break 3% below the 200-SMA, a
// TIME_STOP_DAYS time stop, or a wide catastrophe stop (server-side GTC at the broker).
//
// Hardening over v1 — each item fixes an incident observed in the June–Aug 2026 logs:
//  - OPEN-ORDER AWARENESS + idempotent client_order_id: after-hours orders queue until
//    the next open; v1 looked only at positions and re-bought on re-runs and holiday
//    runs (Jun 18–19: triple-bought XLE/XLV/XOP → cash -$134,792 = 2.35x hidden leverage).
//  - CASH-BUDGETED SIZING: buys spend tracked available cash, never silent margin.
//  - STRATEGY PARTITIONING: manages only its own universe; refuses to start if it
//    overlaps the rotation bot's SECTORS (Jun 22: v1 sold rotation's XLK/XLI).
//  - SERVER-SIDE STOPS: every position carries a broker-side GTC stop, so catastrophe
//    protection exists even if this bot never runs again. Default widened 7%→15%:
//    tight stops are expectancy-negative for mean reversion (Connors/Alvarez), and a
//    resting stop triggers intraday, so 7% would sell normal dip noise.
//  - FAIL-CLOSED EXITS: dividend-adjusted bars (Alpaca SIP first, Yahoo fallback);
//    if data for a HELD symbol is missing, the broker-priced catastrophe stop is still
//    evaluated via the position's own unrealized_plpc and an alert fires — never a
//    silent skip. If the SPY regime gate is configured but SPY data is missing, buys
//    are blocked (v1 silently disabled the gate).
//  - TWO-PASS ENTRIES: signals are collected for the whole universe, ranked by RSI-2
//    depth, then allocated under slot + correlation-cluster caps (v1 filled all slots
//    in SYMBOLS list order — Jul 28 it stacked QQQ+XLK+SMH+SOXX, one bet ×4).
//  - Calendar gate, circuit breaker, order cap, journal, Discord alerts, vol-scaled
//    sizing, async-rejection reconciliation.

import { parseBool, parseNum, parseSymbols, assertDisjoint } from './lib/config.mjs';
import { wilderRSI, sma, realizedVol } from './lib/indicators.mjs';
import * as alpaca from './lib/alpaca.mjs';
import { getDailyBars, isFresh } from './lib/data.mjs';
import { alert, note, flushSummary } from './lib/alerts.mjs';
import { appendRun, circuitCheck, lastBuyDate, lastRunDate, tradingDaysSince } from './lib/journal.mjs';

// ---------- config (hard-fails on garbage; per-bot overrides beat shared vars) ----------
const DRY_RUN = parseBool('DRY_RUN_RSI', parseBool('DRY_RUN', true));
const KILL = parseBool('KILL_SWITCH_RSI', parseBool('KILL_SWITCH', false));
const SYMBOLS = parseSymbols('SYMBOLS', 'SPY,QQQ,DIA,IWM,VTI,MDY,SMH,SOXX,XBI,KRE,ITB,XOP,GDX,EEM,EFA,FXI,EWZ,TLT,IEF,HYG,GLD,SLV');
const SECTORS = parseSymbols('SECTORS', 'XLK,XLF,XLE,XLV,XLY,XLI,XLP,XLU,XLB,XLRE,XLC'); // rotation bot's turf
const ALLOC_PCT = parseNum('ALLOC_PCT', 15, { min: 1, max: 50 }) / 100;
const MAX_POSITIONS = parseNum('MAX_POSITIONS', 6, { min: 1, max: 50 });
const STOP_PCT = parseNum('STOP_PCT', 15, { min: 1, max: 50 }) / 100;   // catastrophe stop, not a trade stop
const BUY_RSI2 = parseNum('BUY_RSI2', 5, { min: 1, max: 50 });
const SELL_RSI2 = parseNum('SELL_RSI2', 65, { min: 50, max: 99 });
const EXIT_MODE = (process.env.EXIT_MODE || 'rsi').trim().toLowerCase();   // 'rsi' | 'sma5' (Connors' published exit)
const ENTRY_MODE = (process.env.ENTRY_MODE || 'market').trim().toLowerCase(); // 'market' | 'limit' (limit at signal close)
const TREND_BUFFER = parseNum('TREND_BUFFER_PCT', 3, { min: 0, max: 20 }) / 100; // hysteresis below 200SMA before trend-break exit
const TIME_STOP_DAYS = parseNum('TIME_STOP_DAYS', 10, { min: 0, max: 60 }); // 0 = off
const SPY_MAX_RSI2 = parseNum('SPY_MAX_RSI2', 100, { min: 1, max: 100 });
const MAX_DRAWDOWN_PCT = parseNum('MAX_DRAWDOWN_PCT', 12, { min: 2, max: 90 });
const RISK_SCALING = parseBool('RISK_SCALING', true);
const VOL_TARGET = parseNum('VOL_TARGET', 20, { min: 5, max: 80 }) / 100;
const MAX_PER_CLUSTER = parseNum('MAX_PER_CLUSTER', 2, { min: 1, max: 50 });
const MIN_ORDER_USD = parseNum('MIN_ORDER_USD', 500, { min: 1, max: 100000 });
const ORDER_CAP = parseNum('ORDER_CAP', 10, { min: 1, max: 50 });       // max BUY orders per run
const FORCE_RUN = parseBool('FORCE_RUN', false);
const ALLOW_INTRADAY = parseBool('ALLOW_INTRADAY', false);
const CIRCUIT_RESET = parseBool('CIRCUIT_RESET', false);

if (!['rsi', 'sma5'].includes(EXIT_MODE)) throw new Error(`CONFIG: EXIT_MODE='${EXIT_MODE}' (use rsi|sma5)`);
if (!['market', 'limit'].includes(ENTRY_MODE)) throw new Error(`CONFIG: ENTRY_MODE='${ENTRY_MODE}' (use market|limit)`);

// Correlated symbols share a cluster; at most MAX_PER_CLUSTER positions per cluster,
// so one factor can't absorb every slot (Jul 28: QQQ+XLK+SMH+SOXX bought same day).
const CLUSTERS = {
  SPY: 'us-broad', QQQ: 'us-broad', DIA: 'us-broad', IWM: 'us-broad', VTI: 'us-broad', MDY: 'us-broad',
  SMH: 'semis', SOXX: 'semis',
  EEM: 'intl', EFA: 'intl', FXI: 'intl', EWZ: 'intl',
  TLT: 'bonds', IEF: 'bonds', HYG: 'bonds',
  GLD: 'metals', SLV: 'metals', GDX: 'metals',
};
const clusterOf = (s) => CLUSTERS[s] || `solo-${s}`;

const journal = { ts: new Date().toISOString(), bot: 'rsi2', dry_run: DRY_RUN, orders: [], incidents: [] };

async function main() {
  console.log(`=== RSI-2 bot ${DRY_RUN ? '[DRY RUN — placing nothing]' : '[LIVE PAPER]'} ${journal.ts} ===`);
  if (KILL) { console.log(`${process.env.KILL_SWITCH_RSI?.trim() ? 'KILL_SWITCH_RSI' : 'KILL_SWITCH'}=true — exiting without trading.`); return; }
  assertDisjoint('SYMBOLS', SYMBOLS, 'SECTORS', SECTORS);

  // --- calendar gate: no decisions off stale bars (holiday runs re-bought in v1) ---
  const { date: today, is_open } = await alpaca.todayET();
  journal.date_et = today;
  const tradingDay = await alpaca.isTradingDay(today);
  if (!tradingDay && !FORCE_RUN) {
    journal.session = false;
    console.log(`${today} is not a trading day — nothing to do (FORCE_RUN=true overrides).`);
    return;
  }
  journal.session = true;
  let dryRun = DRY_RUN;
  if (is_open && !ALLOW_INTRADAY && !dryRun) {
    await alert('warn', 'Market is open — forcing DRY RUN', 'Daily signals would use a partial intraday bar. Set ALLOW_INTRADAY=true to trade intraday anyway.');
    dryRun = true;
  }
  journal.dry_run = dryRun;

  // --- account state ---
  const acct = await alpaca.getAccount();
  const equity = Number(acct.equity);
  const cash = Number(acct.cash);
  journal.equity = equity; journal.cash = cash;
  console.log(`Account ${acct.status} | equity $${equity.toFixed(0)} | cash $${cash.toFixed(0)} | base=${alpaca.BASE}`);
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
  const myPositions = positions.filter(p => SYMBOLS.includes(p.symbol));
  const ordersFor = (sym) => openOrders.filter(o => o.symbol === sym);
  const stopLike = (o) => ['stop', 'stop_limit', 'trailing_stop'].includes(o.type);
  const pendingBuy = (sym) => ordersFor(sym).some(o => o.side === 'buy');
  const pendingSell = (sym) => ordersFor(sym).some(o => o.side === 'sell' && !stopLike(o));
  const openStop = (sym) => ordersFor(sym).find(o => o.side === 'sell' && stopLike(o));
  // A cancel that never reached a terminal state is the dangerous case: Alpaca may still
  // apply it minutes later, leaving the position with no resting stop until the next run.
  // Say so explicitly rather than implying the old stop is safely in place.
  const stopStuck = (id, status, sym) => status === 'pending_cancel'
    ? `stop ${id} still '${status}' after ${alpaca.CANCEL_WAIT_SECONDS}s — not selling ${sym}. `
      + `The cancel may land after this run, leaving ${sym} UNPROTECTED until the next run `
      + `re-places its stop. Check the position now.`
    : `stop ${id} ended '${status}' — shares not free, not selling ${sym}`;
  console.log(`My positions: ${myPositions.map(p => p.symbol).join(', ') || '(none)'} | open orders: ${openOrders.map(o => `${o.side} ${o.symbol}`).join(', ') || '(none)'}`);
  // A position outside BOTH universes gets no exits and no stop reconciliation from anyone —
  // it would sit unmanaged forever. That must be loud on every channel, every day, until it
  // is closed or re-added to a universe (a job-summary note would go unseen).
  const unmanaged = positions.filter(p => !SYMBOLS.includes(p.symbol) && !SECTORS.includes(p.symbol));
  if (unmanaged.length) {
    await alert('error', `UNMANAGED position(s): ${unmanaged.map(p => p.symbol).join(', ')}`,
      'In neither bot\'s universe: no exits, no stop-loss reconciliation, ever. Close them manually or add the symbol back to SYMBOLS/SECTORS.');
    process.exitCode = 1;
  }

  // --- surface async order failures from prior runs (accepted → rejected/expired at open) ---
  try {
    const closed = await alpaca.getClosedOrdersSince(new Date(Date.now() - 2 * 86_400_000).toISOString());
    for (const o of closed.filter(o => o.client_order_id?.startsWith('rsi-'))) {
      if (o.status === 'rejected') {
        // The broker refused an order we believed was placed — the book is not what this run assumes.
        await alert('error', `Order REJECTED after acceptance: ${o.side} ${o.qty ?? o.notional} ${o.symbol}`,
          `client_order_id=${o.client_order_id} — investigate before the next run.`);
        process.exitCode = 1;
      } else if (o.status === 'expired' && o.side === 'sell') {
        // An unfilled DAY buy expiring is normal; an expired SELL means an exit never happened.
        await alert('warn', `Exit order expired unfilled: ${o.side} ${o.qty} ${o.symbol}`,
          `client_order_id=${o.client_order_id} — the position is likely still open; this run re-evaluates it.`);
      }
    }
  } catch (e) { journal.incidents.push(`closed-order check: ${e.message}`); }

  // --- watchdog: a silently dead monthly rotation already cost a full month (Aug 2026,
  // when its run crashed mid-rebalance and nobody noticed for a week). The daily bot is
  // the only thing that runs often enough to notice. Checked on days 2–5 so a missed
  // monthly run is loud without becoming a month of daily nagging. ---
  const dayOfMonth = Number(today.slice(8, 10));
  if (dayOfMonth >= 2 && dayOfMonth <= 5) {
    const lastRot = lastRunDate('rotation');
    if (!lastRot || lastRot.slice(0, 7) !== today.slice(0, 7)) {
      await alert('error', 'Rotation bot has NOT run this month',
        `Last journaled rotation run: ${lastRot ?? 'never'}. Run it manually: Actions → Sector Rotation Bot → Run workflow.`);
      process.exitCode = 1; // red run is the backstop channel when Discord isn't configured
    }
  }

  // --- circuit breaker (blocks new buys only; exits always allowed) ---
  const circuit = circuitCheck(equity, MAX_DRAWDOWN_PCT, { reset: CIRCUIT_RESET });
  journal.circuit = circuit;
  if (circuit.tripped) {
    await alert('error', `CIRCUIT BREAKER: drawdown ${circuit.ddPct.toFixed(1)}% from peak $${circuit.peak.toFixed(0)}`,
      'New buys HALTED (exits still run). Investigate, then set CIRCUIT_RESET=true to re-arm.');
  }
  if (circuit.resetApplied) {
    await alert('warn', `Circuit breaker re-armed at $${equity.toFixed(0)}`, 'Now REMOVE the CIRCUIT_RESET variable — leaving it set auto-re-arms every future trip.');
  }

  // --- data (dividend-adjusted, multi-source, retried). Universe symbols need full
  // indicator history; symbols with queued BUY orders (even outside our universe) are
  // fetched separately just so the cash budget can price them.
  const { bars, failures } = await getDailyBars([...new Set([...SYMBOLS, 'SPY'])], 201);
  const priceOnly = [...new Set(openOrders.filter(o => o.side === 'buy').map(o => o.symbol))].filter(s => !bars.has(s));
  if (priceOnly.length) {
    const extra = await getDailyBars(priceOnly, 2);
    for (const [k, v] of extra.bars) bars.set(k, v);
  }
  for (const f of failures) journal.incidents.push(`data: ${f.sym}: ${f.error}`);
  // Freshness anchor: today IS a trading session (calendar-checked above), so bars are
  // expected through today — never "the newest date any source happened to return",
  // which would wave through a uniformly-stale feed.
  const expected = tradingDay ? today : [...bars.values()].map(b => b.lastDate).sort().at(-1);

  const spyBars = bars.get('SPY');
  const spyRsi2 = spyBars && spyBars.closes.length > 2 ? wilderRSI(spyBars.closes, 2) : null;
  // Fail closed: a CONFIGURED regime gate with missing SPY data blocks buys (v1 silently disengaged it).
  const regimeBlocked = SPY_MAX_RSI2 < 100 && (spyRsi2 == null || !isFresh(spyBars, expected));
  if (regimeBlocked) await alert('warn', 'SPY regime data missing or stale — blocking all buys this run (gate is configured)');
  console.log(`Market regime: SPY RSI-2 = ${spyRsi2 == null ? 'n/a' : spyRsi2.toFixed(0)} | data as of ${expected}\n`);

  // --- cash budget: cash minus what queued buys will consume (sell proceeds not counted).
  // A queued buy we cannot price at all zeroes the budget — the conservative direction. ---
  let budget = Math.max(0, cash);
  for (const o of openOrders.filter(o => o.side === 'buy')) {
    const est = o.notional ? Number(o.notional)
      : Number(o.limit_price || 0) > 0 ? Number(o.qty) * Number(o.limit_price)
      : Number(o.qty) * (bars.get(o.symbol)?.closes.at(-1) ?? NaN);
    if (Number.isFinite(est)) budget -= est;
    else { journal.incidents.push(`unpriceable queued buy ${o.symbol} — buys suspended this run`); budget = 0; }
  }
  budget = Math.max(0, budget);

  // --- slot + cluster occupancy (positions and queued buys both count) ---
  let slots = myPositions.length + openOrders.filter(o => o.side === 'buy' && SYMBOLS.includes(o.symbol)).length;
  const clusterCount = {};
  const bumpCluster = (sym) => { clusterCount[clusterOf(sym)] = (clusterCount[clusterOf(sym)] || 0) + 1; };
  for (const p of myPositions) bumpCluster(p.symbol);
  for (const o of openOrders) if (o.side === 'buy' && SYMBOLS.includes(o.symbol)) bumpCluster(o.symbol);

  let buysPlaced = 0;
  const place = async (order, describe) => {
    if (dryRun) { console.log(`   → WOULD ${describe}`); return { placed: false, dry: true }; }
    const res = await alpaca.placeOrder(order);
    // A duplicate still means the order EXISTS at the broker, so it must be journaled —
    // otherwise the time stop later reads a stale entry date for this position.
    journal.orders.push(order);
    if (res.duplicate) console.log(`   → already placed today (client_order_id dedupe): ${describe}`);
    else { console.log(`   → ${describe} ✅`); await alert('order', describe); }
    return res;
  };

  // --- pass 1: evaluate all symbols — exits act immediately, buy candidates are
  // collected for ranked allocation. Exits run BEFORE stop reconciliation so we never
  // sell shares that a stop placed this same run is holding.
  const buyCandidates = [];
  const exitedSyms = new Set();     // symbols with a sell placed or already pending
  const canceledStops = new Set();  // stops WE canceled this run (the snapshot won't know)
  let staleBlockedBuys = 0;
  for (const sym of SYMBOLS) {
    try {
      const rec = bars.get(sym);
      const pos = myPositions.find(p => p.symbol === sym);
      const brokerLossPct = pos ? Number(pos.unrealized_plpc) : 0; // broker-consistent (split/dividend-safe)

      if (!rec || rec.closes.length < 201) {
        if (pos) {
          if (pendingSell(sym)) { console.log(`${sym}: no data, but exit already queued`); exitedSyms.add(sym); continue; }
          // Fail closed: no market data, but the broker's own P&L still lets us enforce the catastrophe stop.
          if (Number.isFinite(brokerLossPct) && brokerLossPct <= -STOP_PCT) {
            const stop = openStop(sym);
            if (stop && !dryRun) {
              const st = await alpaca.cancelAndWait(stop.id);
              // Only a CONFIRMED cancel frees the shares. Recording it before the check would
              // make pass 2 think the stop is gone and place a second one against shares the
              // first still reserves — a guaranteed 403 plus a false UNPROTECTED alert.
              if (!alpaca.FREED.has(st)) throw new Error(stopStuck(stop.id, st, sym));
              canceledStops.add(sym);
            }
            await place(
              { symbol: sym, qty: pos.qty, side: 'sell', type: 'market', time_in_force: 'day', client_order_id: `rsi-sell-${sym}-${today}` },
              `SELL ${pos.qty} ${sym} @ market (hard stop ${(brokerLossPct * 100).toFixed(1)}% — broker P&L, no market data)`,
            );
            exitedSyms.add(sym);
          } else {
            await alert('error', `No usable data for HELD ${sym} — signal exits not evaluated`,
              `Broker P&L ${(brokerLossPct * 100).toFixed(1)}%; GTC stop still protects it. ${failures.find(f => f.sym === sym)?.error ?? 'insufficient history'}`);
            process.exitCode = 1; // a held position went unevaluated — never a green run
          }
        } else {
          console.log(`${sym}: no/short data, skip`);
        }
        continue;
      }
      const fresh = isFresh(rec, expected);
      if (!fresh) {
        journal.incidents.push(`stale data: ${sym} last bar ${rec.lastDate} vs ${expected}`);
        if (pos) await alert('warn', `Stale data for held ${sym} (${rec.lastDate}) — exits evaluated on old bar`);
      }
      if (rec.source === 'yahoo-RAW') journal.incidents.push(`${sym}: dividend-UNadjusted fallback data in use`);

      const c = rec.closes;
      const last = c.at(-1);
      const sma200 = sma(c, 200);
      const rsi2 = wilderRSI(c, 2);
      const tag = `${sym} $${last.toFixed(2)} rsi2=${rsi2.toFixed(0)} ${last > sma200 ? 'up' : 'DOWN'}trend [${rec.source}]`;

      if (!pos) {
        if (pendingBuy(sym)) { console.log(`${tag} → buy already queued, skip`); continue; }
        if (!(last > sma200 && rsi2 < BUY_RSI2)) { console.log(`${tag} → flat, no dip`); continue; }
        // Exits may run on a stale bar (better late than never); ENTRIES may not — opening
        // a position on prices we know are out of date is never the right trade.
        if (!fresh) { console.log(`${tag} → BUY signal on STALE data (${rec.lastDate} ≠ ${expected}) → no new entry`); staleBlockedBuys++; continue; }
        buyCandidates.push({ sym, last, rsi2, closes: c, tag });
      } else {
        // ---------- exits ----------
        const bounce = EXIT_MODE === 'sma5' ? last > sma(c, 5) : rsi2 > SELL_RSI2;
        const entryDate = TIME_STOP_DAYS > 0 ? lastBuyDate('rsi2', sym) : null;
        const heldDays = entryDate ? tradingDaysSince('rsi2', entryDate) : 0;
        const reason = bounce ? (EXIT_MODE === 'sma5' ? 'bounce close > 5SMA' : `bounce RSI2 ${rsi2.toFixed(0)} > ${SELL_RSI2}`)
          : last < sma200 * (1 - TREND_BUFFER) ? `trend break ${(TREND_BUFFER * 100).toFixed(0)}% below 200SMA`
          : brokerLossPct <= -STOP_PCT ? `hard stop ${(brokerLossPct * 100).toFixed(1)}%`
          : (TIME_STOP_DAYS > 0 && heldDays >= TIME_STOP_DAYS) ? `time stop (${heldDays} sessions)`
          : '';
        if (!reason) { console.log(`${tag} → holding (entry $${Number(pos.avg_entry_price).toFixed(2)}, ${(brokerLossPct * 100).toFixed(1)}%${entryDate ? `, ${heldDays}d` : ''})`); continue; }
        if (pendingSell(sym)) { console.log(`${tag} → sell already queued, skip`); exitedSyms.add(sym); continue; }

        // Cancel the resting stop first and WAIT for the cancel to land — selling while
        // the stop still reserves the shares 403s with "insufficient qty available"
        // (the 2026-08-01 crash), and Alpaca cancels are asynchronous.
        const stop = openStop(sym);
        if (stop && !dryRun) {
          const st = await alpaca.cancelAndWait(stop.id);
          // 'filled' here means the stop already sold the position — selling again would short it.
          // Record the cancel ONLY once it is confirmed: an unconfirmed cancel leaves the old
          // stop resting on the shares, and pass 2 must then leave that stop alone.
          if (!alpaca.FREED.has(st)) throw new Error(stopStuck(stop.id, st, sym));
          canceledStops.add(sym);
          console.log(`${tag} → canceled catastrophe stop ${stop.id.slice(0, 8)}…`);
        }
        await place(
          { symbol: sym, qty: pos.qty, side: 'sell', type: 'market', time_in_force: 'day', client_order_id: `rsi-sell-${sym}-${today}` },
          `SELL ${pos.qty} ${sym} @ market (${reason})`,
        );
        exitedSyms.add(sym);
      }
    } catch (e) {
      journal.incidents.push(`${sym}: ${e.message}`);
      await alert('error', `${sym} failed this run`, e.message);
      process.exitCode = 1; // isolated, but the run must NOT look green
    }
  }

  // --- pass 2: reconcile server-side catastrophe stops for positions we are KEEPING.
  // A stop we canceled this run whose sell then FAILED must be re-placed, so a
  // canceled-by-us stop does not count as "still open".
  for (const pos of myPositions) {
    const sym = pos.symbol;
    const wholeQty = Math.floor(Number(pos.qty));
    if (wholeQty < 1) { if (!exitedSyms.has(sym)) console.log(`${sym}: fractional position (${pos.qty}) — GTC stops need whole shares, relying on daily checks`); continue; }
    if (exitedSyms.has(sym) || (openStop(sym) && !canceledStops.has(sym)) || pendingSell(sym)) continue;
    const stopPrice = (Number(pos.avg_entry_price) * (1 - STOP_PCT)).toFixed(2);
    try {
      await place(
        { symbol: sym, qty: String(wholeQty), side: 'sell', type: 'stop', stop_price: stopPrice, time_in_force: 'gtc', client_order_id: `rsi-stop-${sym}-${today}` },
        `place GTC catastrophe stop: SELL ${wholeQty} ${sym} @ stop $${stopPrice}`,
      );
    } catch (e) {
      // A position ending the run with neither an exit nor a resting stop is exactly what
      // STOP_PCT exists to prevent — that has to fail the run, not warn on a green one.
      journal.incidents.push(`stop ${sym}: ${e.message}`);
      await alert('error', `UNPROTECTED: could not place catastrophe stop for ${sym}`, e.message);
      process.exitCode = 1;
    }
  }

  // --- pass 3: allocate ranked buys (deepest RSI-2 first) under all caps ---
  if (staleBlockedBuys > 0) {
    await alert('warn', `${staleBlockedBuys} buy signal(s) skipped: data older than ${expected}`,
      'Entries need current bars. If this repeats daily, the data feed is not publishing today\'s bar by run time.');
  }
  buyCandidates.sort((a, b) => a.rsi2 - b.rsi2);
  for (const cand of buyCandidates) {
    const { sym, last, rsi2, closes, tag } = cand;
    try {
      if (circuit.tripped) { console.log(`${tag} → BUY signal, but circuit breaker tripped → skip`); continue; }
      if (regimeBlocked) { console.log(`${tag} → BUY signal, but regime gate has no SPY data → skip`); continue; }
      if (spyRsi2 != null && spyRsi2 >= SPY_MAX_RSI2) { console.log(`${tag} → BUY signal, but SPY RSI-2 ${spyRsi2.toFixed(0)} ≥ ${SPY_MAX_RSI2} → skip`); continue; }
      if (buysPlaced >= ORDER_CAP) { console.log(`${tag} → BUY signal, but ORDER_CAP ${ORDER_CAP} reached → skip`); continue; }
      if (slots >= MAX_POSITIONS) { console.log(`${tag} → BUY signal, but ${MAX_POSITIONS} slots full → skip`); continue; }
      const cl = clusterOf(sym);
      if ((clusterCount[cl] || 0) >= MAX_PER_CLUSTER) { console.log(`${tag} → BUY signal, but cluster '${cl}' full (${MAX_PER_CLUSTER}) → skip`); continue; }

      let notional = equity * ALLOC_PCT;
      if (RISK_SCALING && closes.length > 21) {
        const vol = realizedVol(closes, 20);
        notional *= Math.min(1.5, Math.max(0.5, VOL_TARGET / Math.max(vol, 0.01)));
      }
      notional = Math.min(notional, budget);
      const qty = Math.floor(notional / last);
      if (notional < MIN_ORDER_USD || qty < 1) { console.log(`${tag} → BUY signal, but budget $${budget.toFixed(0)} too small → skip`); continue; }
      const spend = qty * last;
      if (!(spend > 0 && spend <= equity * ALLOC_PCT * 1.6)) throw new Error(`sanity: order notional $${spend.toFixed(0)} out of bounds`);

      const order = ENTRY_MODE === 'limit'
        ? { symbol: sym, qty: String(qty), side: 'buy', type: 'limit', limit_price: last.toFixed(2), time_in_force: 'day', client_order_id: `rsi-buy-${sym}-${today}` }
        : { symbol: sym, qty: String(qty), side: 'buy', type: 'market', time_in_force: 'day', client_order_id: `rsi-buy-${sym}-${today}` };
      await place(order, `BUY ${qty} ${sym} (~$${spend.toFixed(0)}, rsi2=${rsi2.toFixed(0)}) @ ${ENTRY_MODE === 'limit' ? `limit $${last.toFixed(2)}` : 'market'}`);
      budget -= spend;
      slots += 1;
      buysPlaced += 1;
      bumpCluster(sym);
    } catch (e) {
      journal.incidents.push(`${sym}: ${e.message}`);
      await alert('error', `${sym} buy failed`, e.message);
      process.exitCode = 1;
    }
  }

  journal.positions = myPositions.map(p => ({ sym: p.symbol, qty: p.qty, entry: p.avg_entry_price, upl: p.unrealized_pl }));
  note(`equity **$${equity.toFixed(0)}** | cash $${cash.toFixed(0)} | positions: ${journal.positions.map(p => p.sym).join(', ') || 'none'} | orders placed: ${journal.orders.length}${journal.incidents.length ? ` | ⚠️ ${journal.incidents.length} incident(s)` : ''}`);
  console.log('\n=== run complete ===');
}

main()
  .catch(async e => {
    journal.incidents.push(`FATAL: ${e.message}`);
    await alert('error', 'RSI-2 bot FATAL', e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try { appendRun(journal); } catch (e) { console.error(`journal write failed: ${e.message}`); }
    flushSummary(`RSI-2 bot — ${journal.date_et ?? journal.ts}`);
  });
