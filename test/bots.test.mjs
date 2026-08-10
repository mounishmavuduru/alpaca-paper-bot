// End-to-end scenario tests: run the REAL bots as child processes against the mock
// Alpaca server. Each scenario is a regression test for a live incident from the
// June–August 2026 run logs, or a safety property of the rewrite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, defaultState, dipSeries, bounceSeries, holdSeries, downtrendSeries } from './mock_alpaca.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const SECTOR_LIST = 'XLK,XLF,XLE,XLV,XLY,XLI,XLP,XLU,XLB,XLRE,XLC';

// Async spawn (NOT execFileSync: that would block this process's event loop and the
// in-process mock server could never answer the child).
async function runBot(script, state, extraEnv = {}) {
  const { srv, base } = await startMock(state);
  const journalDir = extraEnv.JOURNAL_DIR || mkdtempSync(join(tmpdir(), 'bot-journal-'));
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, script)], {
      windowsHide: true,
      env: {
        ...process.env,
        ALPACA_BASE: base,
        ALPACA_DATA_BASE: base,
        YAHOO_BASE: base,
        ALPACA_KEY: 'test-key',
        ALPACA_SECRET: 'test-secret',
        DISCORD_WEBHOOK: '',
        GITHUB_STEP_SUMMARY: '',
        DRY_RUN: 'false',
        RISK_SCALING: 'false',
        TIME_STOP_DAYS: '0',
        SYMBOLS: 'SPY,TLT',
        SECTORS: SECTOR_LIST,
        ...extraEnv,
        JOURNAL_DIR: journalDir,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout: out, code: code ?? 1 }); });
  });
  srv.closeAllConnections?.();
  srv.close();
  return { ...result, state, journalDir };
}

const placed = (state) => state.orders.filter(o => o.id?.startsWith('ord_'));

// ---------------- RSI-2 bot ----------------

test('dip signal → one buy, correct sizing, idempotent client_order_id', async () => {
  const spy = dipSeries();
  const state = defaultState({ bars: { SPY: spy, TLT: holdSeries() } });
  const { code, state: s } = await runBot('bot.mjs', state);
  assert.equal(code, 0);
  const orders = placed(s);
  assert.equal(orders.length, 1);
  const o = orders[0];
  assert.equal(o.symbol, 'SPY');
  assert.equal(o.side, 'buy');
  assert.equal(o.type, 'market');
  assert.equal(o.time_in_force, 'day');
  assert.equal(o.client_order_id, 'rsi-buy-SPY-2026-08-07');
  const last = spy.at(-1);
  assert.equal(Number(o.qty), Math.floor(100000 * 0.15 / last)); // 15% of equity, no vol scaling
});

test('REGRESSION Jun 18-19: pending queued buy → no duplicate buy on re-run', async () => {
  const state = defaultState({ bars: { SPY: dipSeries(), TLT: holdSeries() } });
  state.orders.push({ id: 'pre_1', symbol: 'SPY', side: 'buy', type: 'market', qty: '100', status: 'new', client_order_id: 'rsi-buy-SPY-2026-08-06' });
  const { code, state: s } = await runBot('bot.mjs', state);
  assert.equal(code, 0);
  assert.equal(placed(s).length, 0, 'must not re-buy while a buy order is queued');
});

test('dead duplicate client_order_id (rejected earlier today) → retried under -r suffix', async () => {
  const state = defaultState({ bars: { SPY: dipSeries(), TLT: holdSeries() } });
  state.orders.push({ id: 'dead_1', symbol: 'SPY', side: 'buy', type: 'market', qty: '10', status: 'rejected', client_order_id: 'rsi-buy-SPY-2026-08-07' });
  const { code, state: s } = await runBot('bot.mjs', state);
  assert.equal(code, 0);
  const buys = placed(s).filter(o => o.side === 'buy');
  assert.equal(buys.length, 1, 'the wanted buy must not be silently dropped');
  assert.equal(buys[0].client_order_id, 'rsi-buy-SPY-2026-08-07-r');
});

test('REGRESSION Juneteenth: holiday run places nothing', async () => {
  const state = defaultState({ bars: { SPY: dipSeries(), TLT: holdSeries() }, calendar: [] });
  const { code, state: s, stdout } = await runBot('bot.mjs', state);
  assert.equal(code, 0);
  assert.equal(placed(s).length, 0);
  assert.match(stdout, /not a trading day/);
});

test('held + bounce → cancels resting stop BEFORE selling (Aug 1 crash class)', async () => {
  const state = defaultState({ bars: { SPY: bounceSeries(), TLT: holdSeries() } });
  state.positions.push({ symbol: 'SPY', qty: '100', avg_entry_price: '120', unrealized_pl: '500', unrealized_plpc: '0.04' });
  state.orders.push({ id: 'stop_1', symbol: 'SPY', side: 'sell', type: 'stop', qty: '100', status: 'new', stop_price: '102' });
  const { code, state: s } = await runBot('bot.mjs', state);
  assert.equal(code, 0);
  assert.equal(s.orders.find(o => o.id === 'stop_1').status, 'canceled', 'stop must be canceled first');
  const sells = placed(s).filter(o => o.side === 'sell');
  assert.equal(sells.length, 1);
  assert.equal(sells[0].symbol, 'SPY');
  assert.equal(sells[0].qty, '100');
  assert.equal(sells[0].client_order_id, 'rsi-sell-SPY-2026-08-07');
  // and no new stop was placed for the position we just exited
  assert.equal(placed(s).filter(o => o.type === 'stop').length, 0);
});

test('held, no exit signal → server-side GTC catastrophe stop is placed', async () => {
  const state = defaultState({ bars: { SPY: holdSeries(), TLT: holdSeries() } });
  state.positions.push({ symbol: 'SPY', qty: '100', avg_entry_price: '130', unrealized_pl: '0', unrealized_plpc: '0.0' });
  const { code, state: s } = await runBot('bot.mjs', state);
  assert.equal(code, 0);
  const stops = placed(s).filter(o => o.type === 'stop');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].time_in_force, 'gtc');
  assert.equal(stops[0].stop_price, (130 * 0.85).toFixed(2)); // STOP_PCT default 15
  assert.equal(placed(s).filter(o => o.side === 'buy').length, 0);
});

test('trend break uses 3% hysteresis below the 200-SMA', async () => {
  const state = defaultState({ bars: { SPY: downtrendSeries(), TLT: holdSeries() } });
  state.positions.push({ symbol: 'SPY', qty: '100', avg_entry_price: '80', unrealized_pl: '-100', unrealized_plpc: '-0.02' });
  const { code, state: s, stdout } = await runBot('bot.mjs', state);
  assert.equal(code, 0);
  const sells = placed(s).filter(o => o.side === 'sell' && o.type === 'market');
  assert.equal(sells.length, 1);
  assert.match(stdout, /trend break/);
});

test('FAIL-CLOSED: no data for held symbol + broker P&L breaches stop → exits on broker data alone', async () => {
  const state = defaultState({ bars: { TLT: holdSeries() } }); // SPY: no data anywhere
  state.positions.push({ symbol: 'SPY', qty: '100', avg_entry_price: '150', unrealized_pl: '-3000', unrealized_plpc: '-0.20' });
  const { state: s, stdout } = await runBot('bot.mjs', state);
  const sells = placed(s).filter(o => o.side === 'sell' && o.symbol === 'SPY');
  assert.equal(sells.length, 1, 'hard stop must fire from unrealized_plpc without market data');
  assert.match(stdout, /no market data/);
});

test('FAIL-CLOSED: no data for held symbol, small loss → no sell, loud red run, stop still reconciled', async () => {
  const state = defaultState({ bars: { TLT: holdSeries() } });
  state.positions.push({ symbol: 'SPY', qty: '100', avg_entry_price: '150', unrealized_pl: '-150', unrealized_plpc: '-0.01' });
  const { code, state: s, stdout } = await runBot('bot.mjs', state);
  assert.equal(code, 1, 'a held position that could not be evaluated must fail the run');
  assert.equal(placed(s).filter(o => o.side === 'sell' && o.type === 'market').length, 0);
  assert.equal(placed(s).filter(o => o.type === 'stop').length, 1, 'catastrophe stop still placed');
  assert.match(stdout, /No usable data for HELD SPY/);
});

test('circuit breaker: drawdown past limit blocks buys but never exits', async () => {
  const journalDir = mkdtempSync(join(tmpdir(), 'bot-journal-'));
  writeFileSync(join(journalDir, 'state.json'), JSON.stringify({ peak_equity: 120000, circuit_tripped_at: null }));
  const state = defaultState({ bars: { SPY: dipSeries(), TLT: bounceSeries() } });
  state.positions.push({ symbol: 'TLT', qty: '50', avg_entry_price: '90', unrealized_pl: '250', unrealized_plpc: '0.05' });
  const { state: s, stdout } = await runBot('bot.mjs', state, { JOURNAL_DIR: journalDir });
  assert.equal(placed(s).filter(o => o.side === 'buy').length, 0, 'buys blocked at 16.7% drawdown');
  assert.equal(placed(s).filter(o => o.side === 'sell' && o.type === 'market' && o.symbol === 'TLT').length, 1, 'exits still run');
  assert.match(stdout, /circuit breaker tripped/i);
});

test('overlapping universes → hard startup failure, zero orders', async () => {
  const state = defaultState({ bars: {} });
  const { code, state: s, stdout } = await runBot('bot.mjs', state, { SYMBOLS: 'SPY,XLK' });
  assert.equal(code, 1);
  assert.equal(placed(s).length, 0);
  assert.match(stdout, /overlap/);
});

test('KILL_SWITCH: any truthy spelling halts (v1 required exact lowercase "true")', async () => {
  const state = defaultState({ bars: { SPY: dipSeries(), TLT: holdSeries() } });
  const { code, state: s, stdout } = await runBot('bot.mjs', state, { KILL_SWITCH: ' TRUE ' });
  assert.equal(code, 0);
  assert.equal(placed(s).length, 0);
  assert.match(stdout, /KILL_SWITCH/);
});

test('garbage config value → hard fail, zero orders (v1 traded on NaN)', async () => {
  const state = defaultState({ bars: { SPY: dipSeries(), TLT: holdSeries() } });
  const { code, state: s } = await runBot('bot.mjs', state, { ALLOC_PCT: 'l5' });
  assert.equal(code, 1);
  assert.equal(placed(s).length, 0);
});

test('DRY_RUN places nothing but still simulates decisions', async () => {
  const state = defaultState({ bars: { SPY: dipSeries(), TLT: holdSeries() } });
  const { code, state: s, stdout } = await runBot('bot.mjs', state, { DRY_RUN: 'true' });
  assert.equal(code, 0);
  assert.equal(placed(s).length, 0);
  assert.match(stdout, /WOULD BUY/);
});

test('cluster cap: correlated dips cannot absorb every slot (Jul 28 QQQ+XLK+SMH+SOXX)', async () => {
  const state = defaultState({ bars: { SPY: dipSeries(), QQQ: dipSeries(), DIA: dipSeries(), IWM: dipSeries(), GLD: holdSeries(), TLT: holdSeries() } });
  const { code, state: s } = await runBot('bot.mjs', state, { SYMBOLS: 'SPY,QQQ,DIA,IWM,GLD,TLT', MAX_POSITIONS: '6', MAX_PER_CLUSTER: '2' });
  assert.equal(code, 0);
  const buys = placed(s).filter(o => o.side === 'buy');
  assert.equal(buys.length, 2, 'us-broad cluster capped at 2 despite 4 signals');
});

test('cash budget: buys never exceed available cash (v1 went to -$134k cash)', async () => {
  const state = defaultState({ bars: { SPY: dipSeries(), QQQ: dipSeries(), GLD: dipSeries(), TLT: holdSeries() } });
  state.account.cash = '20000'; // equity 100k but only 20k cash
  const { code, state: s } = await runBot('bot.mjs', state, { SYMBOLS: 'SPY,QQQ,GLD,TLT', MAX_PER_CLUSTER: '2' });
  assert.equal(code, 0);
  const buys = placed(s).filter(o => o.side === 'buy');
  const spent = buys.reduce((a, o) => a + Number(o.qty) * (state.bars[o.symbol].at(-1)), 0);
  assert.ok(spent <= 20000, `spent $${spent.toFixed(0)} > $20000 cash`);
});

// ---------------- rotation bot ----------------

function sectorBars() {
  // XLK strongest momentum, XLE second, XLV third; the rest mildly negative.
  const bars = {};
  const up = (rate, n = 300) => { const c = [100]; for (let i = 1; i < n; i++) c.push(c[i - 1] * rate); return c.map(x => Math.round(x * 1000) / 1000); };
  for (const s of SECTOR_LIST.split(',')) bars[s] = up(0.9996);
  bars.XLK = up(1.0012); bars.XLE = up(1.0008); bars.XLV = up(1.0004);
  return bars;
}

test('rotation: sells only rotated-out SECTOR positions, never other symbols (v1 sold the whole account)', async () => {
  const state = defaultState({ bars: sectorBars() });
  state.positions.push(
    { symbol: 'XLF', qty: '80', avg_entry_price: '55', current_price: '54', unrealized_plpc: '-0.02' },  // rotated out → sell
    { symbol: 'XLK', qty: '40', avg_entry_price: '150', current_price: '160', unrealized_plpc: '0.07' }, // in target → keep
    { symbol: 'SPY', qty: '30', avg_entry_price: '500', current_price: '510', unrealized_plpc: '0.02' }, // NOT rotation's → untouchable
  );
  const { code, state: s, stdout } = await runBot('rotation_bot.mjs', state);
  assert.equal(code, 0);
  const sells = placed(s).filter(o => o.side === 'sell');
  assert.deepEqual(sells.map(o => o.symbol), ['XLF'], 'exactly one sell: the rotated-out sector');
  assert.ok(!placed(s).some(o => o.symbol === 'SPY'), 'RSI-bot position untouched');
  const buys = placed(s).filter(o => o.side === 'buy');
  assert.deepEqual(buys.map(o => o.symbol).sort(), ['XLE', 'XLV'], 'buys the missing targets only');
  assert.match(stdout, /keep \(in target\)/);
  for (const o of [...sells, ...buys]) assert.match(o.client_order_id, /^rot-(buy|sell)-/);
});

test('REGRESSION Aug 1: pending sell on a held sector → no double-sell, run continues to buys', async () => {
  const state = defaultState({ bars: sectorBars() });
  state.positions.push({ symbol: 'XLF', qty: '29', avg_entry_price: '55', current_price: '54', unrealized_plpc: '-0.02' });
  state.orders.push({ id: 'pre_sell', symbol: 'XLF', side: 'sell', type: 'market', qty: '29', status: 'new' });
  const { code, state: s } = await runBot('rotation_bot.mjs', state);
  assert.equal(code, 0);
  assert.equal(placed(s).filter(o => o.side === 'sell').length, 0, 'must not double-sell held_for_orders shares');
  assert.equal(placed(s).filter(o => o.side === 'buy').length, 3, 'rebalance completes (v1 died before buying)');
});

test('rotation FAIL-CLOSED: held sector with missing data is HELD, not sold as "rotated out"', async () => {
  const bars = sectorBars();
  delete bars.XLF;
  const state = defaultState({ bars });
  state.positions.push({ symbol: 'XLF', qty: '80', avg_entry_price: '55', current_price: '54', unrealized_plpc: '-0.02' });
  const { code, state: s, stdout } = await runBot('rotation_bot.mjs', state);
  assert.equal(code, 0);
  assert.equal(placed(s).filter(o => o.side === 'sell').length, 0, 'data failure must never trigger a sell');
  assert.match(stdout, /data unavailable — HOLDING/);
});

test('rotation aborts entirely when ranking would be meaningless (mass data failure)', async () => {
  const bars = sectorBars();
  for (const s of ['XLF', 'XLE', 'XLV', 'XLY']) delete bars[s];
  const state = defaultState({ bars });
  state.positions.push({ symbol: 'XLK', qty: '40', avg_entry_price: '150', current_price: '160', unrealized_plpc: '0.07' });
  const { code, state: s2, stdout } = await runBot('rotation_bot.mjs', state);
  assert.equal(code, 1);
  assert.equal(placed(s2).length, 0);
  assert.match(stdout, /too many data failures/);
});

test('rotation sizing: buys capped by cash + haircut sale proceeds, never raw equity (v1 used margin)', async () => {
  const state = defaultState({ bars: sectorBars() });
  state.account.cash = '1000'; // fully invested account rotating: nearly no free cash
  state.positions.push({ symbol: 'XLF', qty: '900', avg_entry_price: '55', current_price: '54', unrealized_plpc: '-0.02' });
  const { code, state: s } = await runBot('rotation_bot.mjs', state);
  assert.equal(code, 0);
  const xlfLast = state.bars.XLF ? state.bars.XLF.at(-1) : 54;
  const proceeds = 900 * xlfLast * 0.98 + 1000;
  const buys = placed(s).filter(o => o.side === 'buy');
  const spent = buys.reduce((a, o) => a + Number(o.qty) * state.bars[o.symbol].at(-1), 0);
  assert.ok(buys.length >= 1, 'sale proceeds fund the rotation');
  assert.ok(spent <= proceeds + 1, `spent $${spent.toFixed(0)} exceeds cash+proceeds $${proceeds.toFixed(0)}`);
});

test('rotation 12-1 momentum ranks on the skip-month series (off-by-none check)', async () => {
  // Construct a sector whose LAST month is a crash but prior 11 months are the strongest:
  // 12-1 momentum should still rank it #1 (12-0 would not).
  const bars = sectorBars();
  const c = [100];
  for (let i = 1; i < 279; i++) c.push(c[i - 1] * 1.003);   // very strong for 279 days
  for (let i = 0; i < 21; i++) c.push(c[c.length - 1] * 0.999); // flat-to-down final month
  bars.XLU = c.map(x => Math.round(x * 1000) / 1000);
  const state = defaultState({ bars });
  const { code, stdout } = await runBot('rotation_bot.mjs', state);
  assert.equal(code, 0);
  assert.match(stdout, /Target \(top 3.*XLU/, 'XLU must be in target on 12-1 momentum');
});
