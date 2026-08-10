import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JOURNAL_DIR = mkdtempSync(join(tmpdir(), 'journal-test-'));
const { circuitCheck, writeState, appendRun, tradingDaysSince } = await import('../lib/journal.mjs');

test('circuit breaker trips on drawdown, peak only ratchets up', () => {
  writeState({ peak_equity: 0, circuit_tripped_at: null });
  assert.equal(circuitCheck(100000, 12).tripped, false);          // fresh: peak = 100k
  assert.equal(circuitCheck(95000, 12).tripped, false);           // -5%: fine, peak stays 100k
  const r = circuitCheck(85000, 12);
  assert.equal(r.tripped, true);                                  // -15%: tripped
  assert.equal(r.peak, 100000);
});

test('CIRCUIT_RESET re-arms only a TRIPPED breaker; lingering reset cannot ratchet the peak down', () => {
  writeState({ peak_equity: 100000, circuit_tripped_at: '2026-08-01T00:00:00Z' });
  const r = circuitCheck(85000, 12, { reset: true });             // tripped + reset → re-armed at 85k
  assert.equal(r.resetApplied, true);
  assert.equal(r.tripped, false);
  assert.equal(r.peak, 85000);
  // reset left true while NOT tripped: peak must NOT follow equity down
  const r2 = circuitCheck(80000, 12, { reset: true });            // -5.9% from new peak: not tripped
  assert.equal(r2.resetApplied, false);
  assert.equal(r2.peak, 85000, 'lingering reset must not re-base the peak');
});

test('tradingDaysSince ignores non-session (holiday/rotation) journal entries', () => {
  appendRun({ bot: 'rsi2', date_et: '2026-08-03', session: true });
  appendRun({ bot: 'rsi2', date_et: '2026-08-04', session: false });  // holiday run
  appendRun({ bot: 'rotation', date_et: '2026-08-05', session: false });
  appendRun({ bot: 'rsi2', date_et: '2026-08-05', session: true });
  appendRun({ bot: 'rsi2', date_et: '2026-08-05', session: true });   // same-day re-run: one day
  assert.equal(tradingDaysSince('rsi2', '2026-08-01'), 2);
});
