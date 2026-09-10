// Turns each poll's raw agent status into the day's opt-out event history that the
// Opt-In/Opt-Out report reads. Zoom doesn't hand us this history directly, so it's built
// incrementally here: every tick, for every agent, this decides whether an opt-out period
// should open, continue, or close, and keeps login/last-seen timestamps for the day.
const store = require('./eventStore');
const { todayISO, hhmm, epochFromLocal } = require('../time');
const { UNSPECIFIED } = require('./reasons');

const END_SHIFT = 'End Shift';

/**
 * Opt-out periods only started carrying an epoch `openedAt` when the break countdown was
 * added, so a period already open in data/events.json — or one that was open across an
 * upgrade or restart — has only its "HH:MM" start. Recover the timestamp from that rather
 * than treating the break as having begun the moment the server came back, which would
 * hand everyone a fresh 30 minutes on every restart.
 */
function ensureOpenedAt(rec, date) {
  if (rec.open && !rec.open.openedAt) {
    rec.open.openedAt = epochFromLocal(date, rec.open.start) || Date.now();
  }
}

function closeOpen(rec, atTime) {
  if (!rec.open) return;
  rec.periods.push({ start: rec.open.start, end: atTime, reason: rec.open.reason });
  rec.open = null;
}

/**
 * @param {Array<{name:string, ext:string, in:boolean, state:string, reason:?string}>} agents
 *   raw per-agent status for this tick, as produced by agentStatus.loadAllAgents().
 * @returns {Map<string, {start: string, reason: string, openedAt: number}>}
 *   each agent's currently-open opt-out period, keyed by name. The dashboard's break
 *   countdown reads `openedAt` from here — it's an epoch timestamp rather than the `start`
 *   "HH:MM" the report uses, because a timer ticking in seconds can't be driven off a
 *   minute-resolution string. It survives a restart along with the rest of the store, so a
 *   break that began before the process bounced still counts down from the right moment.
 */
function recordTick(agents) {
  const date = todayISO();
  const now = hhmm();

  for (const a of agents) {
    const rec = store.agentFor(date, a.name, a.ext);
    ensureOpenedAt(rec, date);
    const online = a.state !== 'Off shift';
    const optedOut = !a.in;

    if (online) {
      if (!rec.login) rec.login = now;
      rec.lastSeen = now;

      if (optedOut) {
        const reason = a.reason || UNSPECIFIED;
        if (!rec.open) {
          rec.open = { start: now, reason, openedAt: Date.now() };
        } else if (rec.open.reason !== reason) {
          closeOpen(rec, now);
          rec.open = { start: now, reason, openedAt: Date.now() };
        }
      } else {
        closeOpen(rec, now);
      }
    } else {
      // Gone offline. If they had no open opt-out period, their shift just ended while
      // still opted in — record that transition as its own "End Shift" period rather than
      // silently dropping it. This is the one reason the app can actually observe rather
      // than infer: going offline *is* the end of a shift.
      if (!rec.open) {
        rec.open = { start: now, reason: END_SHIFT, openedAt: Date.now() };
      } else if (rec.open.reason !== END_SHIFT) {
        closeOpen(rec, now);
        rec.open = { start: now, reason: END_SHIFT, openedAt: Date.now() };
      }
    }
  }

  store.persist();

  // Hand back the open periods so the snapshot can put a countdown on the ones that carry
  // a time allowance, without agentStatus having to reach into the event store itself.
  const open = new Map();
  for (const a of agents) {
    const rec = store.agentFor(date, a.name, a.ext);
    if (rec.open) open.set(a.name, rec.open);
  }
  return open;
}

module.exports = { recordTick };
