// Alerting: Discord webhook (optional, via DISCORD_WEBHOOK secret) + GitHub Actions
// step summary. Alerts must never crash the bot — they catch and log their own failures.
import { appendFileSync } from 'node:fs';

const WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const lines = [];

export function note(md) { lines.push(md); }

export async function alert(severity, title, body = '') {
  const emoji = { info: 'ℹ️', order: '🟢', warn: '⚠️', error: '🚨' }[severity] || 'ℹ️';
  const msg = `${emoji} **${title}**${body ? `\n${body}` : ''}`;
  note(msg);
  console.log(`[alert:${severity}] ${title}${body ? ' — ' + body.replace(/\n/g, ' | ') : ''}`);
  if (!WEBHOOK) return;
  try {
    const post = () => fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg.slice(0, 1900), username: 'alpaca-bot' }),
      signal: AbortSignal.timeout(10_000),
    });
    let r = await post();
    if (r.status === 429) {
      const retryAfter = Number((await r.json().catch(() => ({}))).retry_after ?? 2);
      await new Promise(res => setTimeout(res, 1000 * Math.min(retryAfter, 10)));
      r = await post();
    }
    if (!r.ok) console.error(`alert webhook HTTP ${r.status}`);
  } catch (e) {
    console.error(`alert webhook failed: ${e.message}`);
  }
}

// Write everything noted this run to the GitHub Actions job summary (free UI, no setup).
export function flushSummary(title) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f || lines.length === 0) return;
  try {
    appendFileSync(f, `## ${title}\n\n${lines.join('\n\n')}\n`);
  } catch (e) {
    console.error(`step summary write failed: ${e.message}`);
  }
}
