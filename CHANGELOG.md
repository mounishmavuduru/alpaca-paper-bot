# v2.0.0 — 2026-08-09 — full hardening after forensic audit

A multi-agent audit of the code plus all 45 GitHub Actions run logs (2026-06-18 → 2026-08-07)
found that v1's +$5,956 two-month paper gain was produced with serious hidden defects.
Every numbered item below was **observed live**, not theoretical.

## Incidents found in the v1 logs

1. **Triple-duplicate buys → 2.35× hidden leverage (Jun 18–22).** Orders placed after
   hours queue until the next open; v1 built its "held" set from positions only, so
   re-runs (two manual + the Juneteenth-holiday run) re-bought identical signals three
   times: 834 XLE, 300 XLV, 291 XOP. Combined with the rotation bot's simultaneous
   deployment, cash hit **−$134,792 on $100k equity**. A 10% market drop would have cost
   ~23.5%. The gain from that leveraged accident is most of the June P&L.
2. **The bots traded each other's books all summer.** The RSI bot's universe contained all
   11 rotation sectors: it sold rotation's XLK/XLI on Jun 22 ("bounce"), rotation re-bought
   Jul 1, RSI sold them again Jul 6–9. The monthly rotation strategy never actually ran.
3. **Aug 1: rotation crashed mid-rebalance and was silently offline all month.** It tried
   to re-sell SMH shares already held by a queued RSI-bot sell (403 `held_for_orders`),
   had no per-order error isolation, died before buying its August targets — and nothing
   alerted anyone for 7+ days.
4. **All signals computed on dividend-UNadjusted closes.** Measured impact: HYG 12-month
   momentum −0.7% raw vs +5.2% adjusted (sign flip), XLU 0.8% vs 3.6%; TLT/HYG trend state
   wrong on 71/250 and 107/250 days respectively; ex-dividend drops read as RSI "dips".
5. **Every error path failed open.** A Yahoo failure on a held symbol silently skipped its
   stop/trend/bounce exits (green run); a rotation data failure sold the affected sector
   as "rotated out"; a full outage would have liquidated the entire account to cash.
6. **Scheduled workflows were 9 days from silent death.** GitHub disables cron workflows
   after 60 days without commits (last commit Jun 18 → auto-disable ~Aug 17), leaving any
   open positions unmanaged with no broker-side stops.
7. Smaller: kill switch required exact lowercase `'true'`; NaN config values silently
   disabled the position cap / stop / qty guard; sizing used equity (not cash) with no
   buying-power check; both crons fired at the same minute on the 1st (Jul 1: 3s apart);
   no journal, no alerts, no tests; comment misstated the DST math.

## What v2 does about it

- Open-order awareness + per-day `client_order_id` idempotency (fixes 1, 3).
- Disjoint universes enforced at startup; rotation touches only its SECTORS (fixes 2).
- Cash-budgeted sizing; rotation buys funded by cash + haircut sale proceeds (fixes 1, 7).
- Server-side GTC catastrophe stops on every position, reconciled daily; exits cancel the
  stop first (fixes 3, 6); stop default widened 7%→15% per Connors/Alvarez evidence that
  tight stops damage mean-reversion expectancy.
- Dividend-adjusted bars: Alpaca Market Data (SIP, `adjustment=all`) primary, Yahoo
  `adjclose` fallback, retries + freshness validation (fixes 4).
- Fail-closed everywhere: held-symbol data failure = red run + alert + broker-P&L stop
  check; rotation holds (never sells) on missing data and aborts on mass failure (fixes 5).
- Trading-calendar gate (no holiday runs), intraday-run guard, market-clock ET dating.
- Two-pass entries ranked by RSI-2 depth + correlation-cluster caps; vol-scaled sizing;
  12-1 momentum (optional 3/6/12 blend); 10-session time stop; drawdown circuit breaker;
  order caps and per-order notional sanity bounds.
- Hardened config parsing (case/space-tolerant booleans, hard fail on garbage), per-bot
  DRY_RUN/KILL_SWITCH overrides, live-endpoint interlock (`I_UNDERSTAND_LIVE`).
- Ops: serialized workflows (shared concurrency group), off-peak cron minutes, SHA-pinned
  actions, minimal permissions, `timeout-minutes`, Node 24, committed JSONL journal (also
  the 60-day-disable keepalive), Discord alerts + failure steps, async-rejection
  reconciliation (accepted-then-rejected orders surface next run).
- 41 tests: indicator golden values, config + circuit-breaker units, and 28 end-to-end
  scenarios running the real bots against a mock Alpaca broker — including regression tests
  for incidents 1, 2, 3, and 5 above.
- A watchdog in the daily bot alerts (and fails the run) if no rotation run was journaled by
  the 2nd–5th of a month, so incident 3 cannot silently repeat.
