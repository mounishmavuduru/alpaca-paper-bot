// Append-only trade journal (journal/journal.jsonl) + tiny state file (journal/state.json).
// The workflow commits journal/ back to the repo after each run, which doubles as the
// keepalive that stops GitHub from auto-disabling the cron after 60 idle days.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.env.JOURNAL_DIR || 'journal';

export function readState() {
  try {
    return JSON.parse(readFileSync(join(DIR, 'state.json'), 'utf8'));
  } catch {
    return { peak_equity: 0, circuit_tripped_at: null };
  }
}

export function writeState(state) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

export function appendRun(record) {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(join(DIR, 'journal.jsonl'), JSON.stringify(record) + '\n');
}

function readRuns() {
  try {
    return readFileSync(join(DIR, 'journal.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// ET date of a strategy's most recent journaled run (any outcome).
export function lastRunDate(bot) {
  const runs = readRuns();
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].bot === bot && runs[i].date_et) return runs[i].date_et;
  }
  return null;
}

// ET date of this strategy's most recent BUY of `sym`, from the committed journal.
export function lastBuyDate(bot, sym) {
  const runs = readRuns();
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.bot !== bot || !Array.isArray(r.orders)) continue;
    if (r.orders.some(o => o.symbol === sym && o.side === 'buy')) return r.date_et ?? null;
  }
  return null;
}

// Trading days elapsed since dateET, counted as distinct journaled run dates for this bot
// (each daily run on a trading session = one trading day; holiday runs are journaled
// with session:false and excluded; journal gaps undercount, which only delays a
// time-stop — the safe direction).
export function tradingDaysSince(bot, dateET) {
  if (!dateET) return 0;
  const dates = new Set(readRuns()
    .filter(r => r.bot === bot && r.session !== false && r.date_et && r.date_et > dateET)
    .map(r => r.date_et));
  return dates.size;
}

// Circuit breaker: track peak equity; refuse NEW BUYS when drawdown from peak exceeds
// maxDrawdownPct. Exits/sells are never blocked. CIRCUIT_RESET=true re-arms a TRIPPED
// breaker (re-bases the peak at current equity) — and only a tripped one, so a
// forgotten reset variable cannot silently ratchet the peak down and disable the
// breaker. Peak only ever rises otherwise.
export function circuitCheck(equity, maxDrawdownPct, { reset = false } = {}) {
  const state = readState();
  let resetApplied = false;
  if (reset && state.circuit_tripped_at) {
    state.peak_equity = equity;
    state.circuit_tripped_at = null;
    resetApplied = true;
  }
  if (equity > state.peak_equity) state.peak_equity = equity;
  const ddPct = state.peak_equity > 0 ? (1 - equity / state.peak_equity) * 100 : 0;
  const tripped = !resetApplied && ddPct >= maxDrawdownPct;
  if (tripped && !state.circuit_tripped_at) state.circuit_tripped_at = new Date().toISOString();
  if (!tripped) state.circuit_tripped_at = null;
  writeState(state);
  return { tripped, ddPct, peak: state.peak_equity, resetApplied };
}
