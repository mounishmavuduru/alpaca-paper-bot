// Env-var parsing that FAILS HARD on garbage instead of silently trading with NaN.

export function parseBool(name, def, env = process.env) {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return def;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new Error(`CONFIG: ${name}='${raw}' is not a boolean (use true/false)`);
}

export function parseNum(name, def, { min = -Infinity, max = Infinity, env = process.env } = {}) {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return def;
  const n = Number(raw.trim().replace(/%$/, ''));
  if (!Number.isFinite(n)) throw new Error(`CONFIG: ${name}='${raw}' is not a number`);
  if (n < min || n > max) throw new Error(`CONFIG: ${name}=${n} outside [${min}, ${max}]`);
  return n;
}

const SYM_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
export function parseSymbols(name, def, env = process.env) {
  const raw = env[name];
  const list = (raw == null || raw.trim() === '' ? def : raw)
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (list.length === 0) throw new Error(`CONFIG: ${name} is empty`);
  const bad = list.filter(s => !SYM_RE.test(s));
  if (bad.length) throw new Error(`CONFIG: ${name} has invalid symbols: ${bad.join(', ')}`);
  const dupes = list.filter((s, i) => list.indexOf(s) !== i);
  if (dupes.length) throw new Error(`CONFIG: ${name} has duplicates: ${[...new Set(dupes)].join(', ')}`);
  return list;
}

// Refuse to run two strategies over overlapping universes on one account —
// they will trade each other's positions (this happened: rotation-owned XLK/XLI
// were sold by the RSI bot in June 2026, and the Aug 1 rotation run crashed on
// a double-sell). Override only if you really know what you're doing.
export function assertDisjoint(aName, a, bName, b, env = process.env) {
  const overlap = a.filter(s => b.includes(s));
  if (overlap.length && !parseBool('ALLOW_UNIVERSE_OVERLAP', false, env)) {
    throw new Error(`CONFIG: ${aName} and ${bName} overlap (${overlap.join(', ')}). ` +
      `Two strategies must not manage the same symbols on one account. ` +
      `Set ALLOW_UNIVERSE_OVERLAP=true to override.`);
  }
  return overlap;
}
