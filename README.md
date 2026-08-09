# Alpaca Paper Bot 🤖 — RSI-2 dip buyer + monthly sector rotation

Two independent strategies on one Alpaca **paper** account, scheduled by GitHub Actions,
no laptop needed. **v2** is a ground-up hardening after a forensic audit of the June–August
2026 live-paper run found the two v1 bots silently levering the account 2.35× and selling
each other's positions (details in `CHANGELOG.md`).

**Strategies**
- **RSI-2 dip buyer** (`bot.mjs`, daily): buy an ETF closing above its 200-day average with
  RSI-2 < 5; exit on the bounce (RSI-2 > 65), a trend break (3% below the 200-day), a
  10-session time stop, or a wide catastrophe stop that rests **server-side at the broker**.
  22-ETF universe across equity/bond/commodity/international.
- **Sector rotation** (`rotation_bot.mjs`, monthly): hold the top-3 of 11 SPDR sectors by
  **12-1 momentum** (dividend-adjusted), positive momentum only, else cash.

The universes are **disjoint by design** and both bots refuse to start if you configure them
to overlap — on a shared account, overlapping strategies liquidate each other.

## Safety model (what v2 guarantees)

| Property | Mechanism |
|---|---|
| No duplicate orders, ever | open-order awareness + deterministic `client_order_id` per (bot, side, symbol, day) — Alpaca rejects replays server-side |
| No hidden leverage | buys spend a tracked cash budget (pending orders deducted), never raw equity |
| Crash protection survives bot death | GTC stop order at the broker for every position (default 15% — a *catastrophe* stop; tight stops provably hurt mean-reversion) |
| Data failures fail **closed** | dividend-adjusted bars from Alpaca (SIP) with Yahoo fallback and retries; a held symbol with no data = red run + alert + broker-P&L stop check, never a silent skip |
| One strategy per symbol | disjoint universes enforced at startup; rotation only ever touches its own SECTORS |
| Bots never run concurrently | shared `concurrency` group across both workflows |
| Drawdown circuit breaker | buys halt at 12% below peak equity (exits unaffected); re-arm with `CIRCUIT_RESET=true` |
| Config typos can't trade | every env var is validated; garbage = hard fail before any order |
| You hear about everything | Discord webhook alerts (orders, warnings, failures), GitHub job summaries, failure emails, committed trade journal |
| Schedules never silently die | the journal auto-commit after each run resets GitHub's 60-day inactivity clock |

## Setup (~10 min)

1. **Alpaca paper keys** — sign up at alpaca.markets (free), switch to Paper Trading,
   generate API Key ID + Secret.
2. **Repo secrets** (Settings → Secrets and variables → Actions → Secrets):
   `ALPACA_KEY`, `ALPACA_SECRET`, and optionally `DISCORD_WEBHOOK` (a Discord channel
   webhook URL — strongly recommended; it is your order/failure feed).
3. **It starts in DRY-RUN.** Watch a few runs in the Actions tab, then set repo **Variable**
   `DRY_RUN` = `false` to trade paper for real.

Manual run any time: Actions tab → pick a workflow → "Run workflow". Safe to spam — runs
are idempotent per day, and intraday manual runs force DRY-RUN (daily signals need a
completed bar; override with `ALLOW_INTRADAY=true` if you know what you're doing).

## Config (repo Variables; all optional)

**Shared:** `DRY_RUN` (true), `KILL_SWITCH` (false) — plus per-bot overrides
`DRY_RUN_RSI` / `DRY_RUN_ROT` / `KILL_SWITCH_RSI` / `KILL_SWITCH_ROT` so you can pause one
strategy without the other.

**RSI-2 bot:** `SYMBOLS` (22 ETFs), `ALLOC_PCT` (15), `MAX_POSITIONS` (6),
`MAX_PER_CLUSTER` (2 — max positions per correlation cluster, so six index-fund dips can't
become one 90% beta bet), `STOP_PCT` (15), `TIME_STOP_DAYS` (10), `SPY_MAX_RSI2` (100 = off;
try 50 to buy dips only when the whole market is weak), `MAX_DRAWDOWN_PCT` (12),
`ENTRY_MODE` (market | `limit` = limit at signal close, cuts open-auction slippage at the
cost of missing gap-up entries), `EXIT_MODE` (rsi | `sma5` = Connors' published exit),
`BUY_RSI2` (5), `SELL_RSI2` (65), `RISK_SCALING` (true — position size scales inversely
with 20-day volatility, ±50%), `CIRCUIT_RESET` (false).

**Rotation bot:** `SECTORS` (11 SPDRs), `TOP_N` (3), `MOM_SKIP` (21 — trading days skipped
for 12-1 momentum; 0 restores v1's 12-0), `MOM_BLEND` (false — rank on mean of 3m/6m/12-1m),
`ROT_ALLOC_PCT` (90).

## Journal

Every run appends to `journal/journal.jsonl` (equity, cash, positions, every order, every
incident) and the workflow commits it back — a permanent, diffable trade history that also
keeps the schedules alive. `journal/state.json` carries the circuit-breaker peak.

## Development

```bash
npm test          # 31 tests: indicator golden values, config validation, and 21 end-to-end
                  # scenarios running the real bots against a mock Alpaca server
npm run trade     # run the RSI-2 bot locally (needs ALPACA_KEY/SECRET; DRY_RUN defaults true)
npm run rotate    # run the rotation bot locally
```

Layout: `lib/` (config, indicators, Alpaca client, data layer, journal, alerts),
`bot.mjs` + `rotation_bot.mjs` (strategy entry points), `test/` (unit + mock-broker
integration), `.github/workflows/` (trade, rotation, tests — SHA-pinned, serialized,
journal commit-back).

## Known limitations (deliberate)

- Signals at the close, fills at the next open: published RSI-2 stats assume buy-at-close,
  so expect somewhat less than backtest numbers. `ENTRY_MODE=limit` recovers part of it; a
  pre-close execution mode (~3:50pm ET) would recover more but trades on a partial bar.
- New entries are unprotected from fill (next open) until that evening's run places the GTC
  stop — an hours-long gap, accepted to keep entries simple whole-share market orders.
- The rotation bot has no intra-month exit by design (momentum strategies are held monthly);
  the account-level circuit breaker is the backstop.
- This repo is public unless you change it: your Actions logs (equity, positions, orders)
  are world-readable. Fine for paper; **make the repo private before ever pointing it at
  real money.**

## 🚨 Going to REAL money later

The code requires a deliberate two-key turn: the live endpoint refuses to start without
`I_UNDERSTAND_LIVE=yes`. Before even considering it: months of clean paper runs, the
Discord feed wired and read daily, the repo private, and money you can afford to lose.
**Honest reminder:** this system's edge is discipline and lower drawdowns, not riches —
keep the bulk in boring index funds.
