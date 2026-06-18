# Alpaca RSI-2 Paper Bot 🤖

A bot that buys-the-dip and sells-the-bounce **automatically, in the cloud, with your laptop closed.**
Runs on **Alpaca paper trading (fake money)**. Data from Yahoo, orders via Alpaca, scheduled by GitHub Actions.

**Strategy:** buy when an ETF is above its 200-day average AND RSI-2 < 5 (a sharp dip); sell when RSI-2 > 65 (the bounce). Default symbols: SPY, QQQ, DIA, IWM.

**Starts in DRY-RUN** — it logs what it *would* do and places NOTHING until you flip it on. Safe by design.

---

## One-time setup (~10 min)

### 1. Get free Alpaca paper keys
- Sign up at **alpaca.markets** (free).
- Switch to **Paper Trading** (toggle in the dashboard — it's the fake-money mode).
- Generate an **API Key ID** + **Secret Key**. Copy both (you only see the secret once).

### 2. Put this folder in a GitHub repo
```bash
cd ~/alpaca-paper-bot
git init && git add -A && git commit -m "Alpaca RSI-2 paper bot"
# create an EMPTY repo on github.com, then:
git remote add origin https://github.com/<you>/alpaca-paper-bot.git
git branch -M main && git push -u origin main
```

### 3. Add your keys as repo secrets
In your repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**
- `ALPACA_KEY` = your paper API Key ID
- `ALPACA_SECRET` = your paper Secret Key

(You never paste keys into code — GitHub injects them privately. Even the bot author can't see them.)

### 4. It's live (in dry-run)
- Runs automatically **weekdays ~30 min after US close.** Watch the **Actions tab** for the log each day.
- Hit **"Run workflow"** in the Actions tab to test it right now.

### 5. When ready to actually place paper trades
**Settings → Secrets and variables → Actions → Variables tab → New variable:**
- `DRY_RUN` = `false`

Now it places real (paper) orders. Watch your Alpaca paper dashboard fill up.

---

## Config (optional Variables, same Variables tab)
| Variable | Default | Meaning |
|----------|---------|---------|
| `DRY_RUN` | `true` | `true` = log only. `false` = actually trade paper. |
| `SYMBOLS` | `SPY,QQQ,DIA,IWM` | Comma-separated ETFs to trade. |
| `ALLOC_PCT` | `20` | % of equity per position. |
| `MAX_POSITIONS` | `3` | Max holdings at once. |
| `KILL_SWITCH` | `false` | Set `true` to halt ALL trading instantly. |
| `STOP_PCT` | `7` | Hard stop-loss %: sell a position if it falls this far below entry (crash protection). |

**Exits (3 ways a position is sold):** the bounce (RSI-2 > 65), a **trend break** (price closes below its 200-day average), or a **hard stop** (down `STOP_PCT`% from entry). The two stops are research-mandated — the no-stop version wipes out in 2008/2020/2022 crashes.

## Safety built in
- DRY-RUN by default · position caps · kill switch · per-symbol error isolation · only trades your listed ETFs · market orders fill at next open (no lookahead).

---

## 🚨 Going to REAL money later (read before you even think about it)
The bot is *built* to switch, but going live is **your decision and your hands — never the bot author's.**

**The technical change is tiny:**
1. Set env `ALPACA_BASE` = `https://api.alpaca.markets` (the LIVE endpoint).
2. Use **live** API keys (from your funded live Alpaca account), not paper keys.
3. Fund the live account with real money.

**But do NOT flip it until ALL of these are true:**
- ✅ It's run on paper for **months** and behaved exactly as expected.
- ✅ You've added **hard loss limits + a daily circuit-breaker** (ask Claude to "harden the bot for live trading").
- ✅ You're starting with **money you can afford to lose** — not your whole account.
- ✅ You get a **trade alert on every order** so nothing happens silently.

**Honest reminder:** this strategy makes *less total money* than just holding an index fund — its edge is lower risk + high win rate, not riches. Automate it for the disciplined, low-stress slice; keep the bulk in boring index funds.
