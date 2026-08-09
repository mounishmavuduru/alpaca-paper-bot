// Pure indicator math on arrays of daily closes (oldest → newest).

// Wilder RSI: seed = simple average of first `p` gains/losses, then Wilder smoothing
// over the remainder of the series. Returns 0..100. Needs at least p+1 closes.
export function wilderRSI(closes, p) {
  if (closes.length < p + 1) throw new Error(`wilderRSI needs ${p + 1}+ closes, got ${closes.length}`);
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    g += Math.max(d, 0);
    l += Math.max(-d, 0);
  }
  g /= p; l /= p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
  }
  if (l === 0 && g === 0) return 50; // flat series: no direction, not "max overbought"
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

export function sma(closes, n) {
  if (closes.length < n) throw new Error(`sma needs ${n}+ closes, got ${closes.length}`);
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}

// Momentum with optional skip of the most recent `skip` bars (12-1 momentum: lookback=252, skip=21).
export function momentum(closes, lookback, skip = 0) {
  if (closes.length < lookback + 1) throw new Error(`momentum needs ${lookback + 1}+ closes, got ${closes.length}`);
  const end = closes[closes.length - 1 - skip];
  const start = closes[closes.length - 1 - lookback];
  return end / start - 1;
}

// Annualized realized volatility from the last `n` daily log returns.
export function realizedVol(closes, n) {
  if (closes.length < n + 1) throw new Error(`realizedVol needs ${n + 1}+ closes, got ${closes.length}`);
  const rets = [];
  for (let i = closes.length - n; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(varc) * Math.sqrt(252);
}
