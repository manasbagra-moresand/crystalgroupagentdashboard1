// Central config. Zoom credentials and the poll interval come from the environment
// (see .env.example) so nothing secret ever lives in source control.
require('dotenv').config();

// --- Admin login for the dashboard's own login screen -----------------------------------
// Per explicit instruction this stays hardcoded in source rather than in the environment.
// It is only ever read here, on the server, and compared server-side (src/auth/session.js) —
// it is never sent to the browser in any HTML/JS/API response.
//
// SECURITY NOTE: this is a weak, shared password sitting in plaintext in version control.
// Before this goes anywhere near a real deployment, move these two lines to
// ADMIN_USERNAME / ADMIN_PASSWORD environment variables and pick a strong, unique password —
// this one has already been typed into a chat session and should be treated as compromised.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'crystaltravel';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'P@$$w0rd';

/**
 * Parses "Break:15,Meal:30" into { Break: 900000, Meal: 1800000 } — reason to allowance
 * in milliseconds. Minutes in the config because that's how break policy is written down;
 * milliseconds in the code because that's what the countdown arithmetic needs.
 *
 * A malformed or non-positive entry is dropped rather than defaulted, so a typo shows up
 * as that reason having no timer instead of silently inventing an allowance for it.
 */
function parseAllowances(spec) {
  const out = {};
  for (const part of String(spec).split(',')) {
    const [reason, minutes] = part.split(':').map(s => (s || '').trim());
    const mins = Number(minutes);
    if (!reason || !Number.isFinite(mins) || mins <= 0) continue;
    out[reason] = mins * 60 * 1000;
  }
  return out;
}

module.exports = {
  port: Number(process.env.PORT) || 3000,
  sessionSecret: process.env.SESSION_SECRET || 'change-me-to-a-long-random-string',

  adminUsername: ADMIN_USERNAME,
  adminPassword: ADMIN_PASSWORD,

  zoom: {
    accountId: process.env.ZOOM_ACCOUNT_ID || '',
    clientId: process.env.ZOOM_CLIENT_ID || '',
    clientSecret: process.env.ZOOM_CLIENT_SECRET || '',
  },

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 5000,

  // Wall-clock zone for every date and time this app records or displays. Crystal Group's
  // contact centre is UK-based, so the dashboard reads in UK time no matter what zone the
  // server or the viewer's browser happens to be in. "Europe/London" — not a fixed +01:00 —
  // so it stays correct across the BST/GMT switch in March and October.
  timeZone: process.env.TIME_ZONE || 'Europe/London',

  // How many Zoom requests may be in flight at once during a poll. Zoom rate-limits the
  // Phone API per second, and a poll touches every queue and every agent, so this is the
  // knob that keeps a large account under the ceiling. Raise it for faster polls, lower it
  // if you start seeing 429s in the snapshot warnings.
  zoomConcurrency: Number(process.env.ZOOM_CONCURRENCY) || 8,

  // Queues whose opt-out counts/labels show up on the dashboard. If left empty the app
  // discovers every call queue on the account instead (see zoom/client.js#listCallQueues).
  queueNameFilter: (process.env.QUEUE_NAMES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // Business unit(s) the dashboard covers, matched against each Zoom phone user's
  // `department` OR `cost_center` (Zoom phone users have no "group" field). Comparison is
  // trimmed and lower-cased here so the values below can be written naturally; matching is
  // exact-after-normalising, so "Crystal UK" will not also match "Crystal US".
  // Empty = every phone user on the account.
  departmentFilter: (process.env.DEPARTMENTS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),

  // How often to re-sweep every call queue on the account to find which ones contain agents
  // from the department(s) above. Between sweeps only those queues are polled, which is what
  // makes a 190-queue account affordable. Queue membership changes rarely; opt-in/opt-out
  // inside a queue is picked up on every poll regardless.
  queueDiscoveryMs: Number(process.env.QUEUE_DISCOVERY_MS) || 10 * 60 * 1000,

  // How long the phone-user roster and the call-queue list are reused between polls.
  // Measured on the live account: listing 477 phone users costs ~3.9s and listing 188 call
  // queues ~0.8s, every single tick, for data that changes when someone joins or leaves the
  // company. At a 5s poll that dwarfs the live signals we actually came for, so it's cached.
  rosterTtlMs: Number(process.env.ROSTER_TTL_MS) || 10 * 60 * 1000,

  // How long an agent's call log (their attended/abandoned counts) is reused. This is the
  // single most expensive part of a poll — ~10.3s for 60 agents — and the counts are
  // day-to-date totals that don't need second-by-second freshness. Refreshes are also
  // spread across ticks rather than all expiring at once (see agentStatus.refreshCallLogs).
  callLogTtlMs: Number(process.env.CALL_LOG_TTL_MS) || 60 * 1000,

  // How long an agent gets before the dashboard counts them over, per opt-out reason.
  // Shown as a countdown on their row, which keeps counting once it passes zero so an
  // overrun is as visible as the time remaining. A reason that isn't listed gets no timer.
  //
  // "Unspecified" carries the longer, Meal-length allowance on purpose. Zoom's API never
  // reveals which reason an agent picked (see services/reasons.js), so on this account
  // every on-break agent lands in Unspecified and something has to be assumed. Assuming
  // the short 15 minutes would flag everyone genuinely at lunch as over at the 15-minute
  // mark — with several agents on break at a time, that's a wall of false red, and a
  // supervisor stops trusting the colour within a day. Erring long misses a short-break
  // overrun instead, which is the cheaper mistake. Set BREAK_ALLOWANCES to trade the other
  // way, or drop Unspecified entirely once reasons come from a source that reports them.
  breakAllowances: parseAllowances(process.env.BREAK_ALLOWANCES || 'Break:15,Meal:30,Unspecified:30'),
};
