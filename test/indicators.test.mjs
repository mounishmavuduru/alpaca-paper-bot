import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilderRSI, sma, momentum, realizedVol } from '../lib/indicators.mjs';

// Independent reference implementation: Wilder RSI via EWM with alpha = 1/p
// (mathematically identical smoothing, structurally different code path).
function refRSI(closes, p) {
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  let g = gains.slice(0, p).reduce((a, b) => a + b, 0) / p;
  let l = losses.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const alpha = 1 / p;
  for (let i = p; i < gains.length; i++) {
    g = g + alpha * (gains[i] - g);
    l = l + alpha * (losses[i] - l);
  }
  if (l === 0 && g === 0) return 50;
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

test('RSI matches independent EWM reference on pseudo-random walks', () => {
  // deterministic LCG so the test is reproducible
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let trial = 0; trial < 20; trial++) {
    const closes = [100];
    for (let i = 0; i < 300; i++) closes.push(closes[closes.length - 1] * (1 + (rand() - 0.5) * 0.04));
    for (const p of [2, 14]) {
      assert.ok(Math.abs(wilderRSI(closes, p) - refRSI(closes, p)) < 1e-9, `p=${p} trial=${trial}`);
    }
  }
});

test('RSI hand-computed golden value', () => {
  // closes: 44.34, 44.09, 44.15, 43.61, 44.33  (period 2)
  // deltas: -0.25, +0.06, -0.54, +0.72
  // seed: g=(0+0.06)/2=0.03  l=(0.25+0)/2=0.125
  // d=-0.54: g=0.015 l=0.3325 ; d=+0.72: g=0.3675 l=0.16625
  // RSI = 100 - 100/(1 + 0.3675/0.16625) = 68.8524...
  const rsi = wilderRSI([44.34, 44.09, 44.15, 43.61, 44.33], 2);
  assert.ok(Math.abs(rsi - 68.85245901639344) < 1e-9, `got ${rsi}`);
});

test('RSI extremes and edge cases', () => {
  assert.equal(wilderRSI([1, 2, 3, 4, 5], 2), 100);          // all gains
  assert.ok(wilderRSI([5, 4, 3, 2, 1], 2) < 1e-9);           // all losses -> ~0
  assert.equal(wilderRSI([5, 5, 5, 5], 2), 50);              // flat -> neutral, NOT 100
  assert.equal(wilderRSI([1, 2, 3], 2), 100);                // minimum length p+1
  assert.throws(() => wilderRSI([1, 2], 2));                 // too short
});

test('sma', () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([10, 20, 30], 3), 20);
  assert.throws(() => sma([1], 2));
});

test('momentum 12-0 and 12-1', () => {
  const closes = Array.from({ length: 300 }, (_, i) => 100 + i); // linear ramp
  // 12-0: last / closes[len-1-252] - 1
  assert.ok(Math.abs(momentum(closes, 252) - (399 / 147 - 1)) < 1e-12);
  // 12-1: skips the last 21 bars
  assert.ok(Math.abs(momentum(closes, 252, 21) - (378 / 147 - 1)) < 1e-12);
  assert.throws(() => momentum([1, 2, 3], 252));
});

test('realizedVol on constant-return series is ~0, scales with noise', () => {
  const steady = Array.from({ length: 30 }, (_, i) => 100 * 1.001 ** i);
  assert.ok(realizedVol(steady, 20) < 1e-9);
  const noisy = [100];
  for (let i = 0; i < 30; i++) noisy.push(noisy[noisy.length - 1] * (i % 2 ? 1.02 : 0.98));
  assert.ok(realizedVol(noisy, 20) > 0.2);
  assert.throws(() => realizedVol([1, 2], 5));
});
