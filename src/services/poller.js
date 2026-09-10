// The single background loop that talks to Zoom. On every tick it:
//   1. pulls raw live status for every agent (agentStatus.loadAllAgents),
//   2. feeds it to the opt-out event tracker so today's history keeps building, and
//   3. caches a decorated snapshot for the dashboard routes to serve instantly.
// HTTP requests never call Zoom directly — they just read whatever this loop last cached —
// so the poll interval is also the effective Zoom API rate this app generates.
const config = require('../config');
const agentStatus = require('./agentStatus');
const { recordTick } = require('./optOutTracker');

let latest = { agents: { optedIn: [], optedOut: [] }, kpis: {}, warnings: ['No data yet — waiting on first Zoom poll.'], updatedAt: null };
let timer = null;
let inFlight = false;  // a poll is currently talking to Zoom
let generation = 0;    // bumped by stop(), so an in-flight poll knows it's been cancelled

async function tick() {
  const startedAt = Date.now();
  try {
    const { agents, warnings } = await agentStatus.loadAllAgents();
    // recordTick must run before buildSnapshot: it's what opens the break period whose
    // start time the snapshot's countdown is measured from.
    const openPeriods = recordTick(agents);

    // Warn only when the poll is badly outpaced, not merely a little over. Now that the
    // loop paces to the interval (see runLoop), a poll a few hundred ms over a 5s target
    // is the healthy steady state, not a fault — warning on every such tick would train
    // people to ignore the banner. Two-times-over means the dashboard really is showing
    // data at half the cadence you asked for.
    //
    // Note the advice deliberately omits ZOOM_CONCURRENCY: measured on this account, a
    // 60-agent presence sweep takes 3.2s at concurrency 8 and 4.6s at 40. Zoom's own
    // per-request latency is the limit, so raising it does nothing.
    const tookMs = Date.now() - startedAt;
    const all = tookMs > config.pollIntervalMs * 2
      ? [...warnings, `A poll takes ${(tookMs / 1000).toFixed(1)}s, more than twice POLL_INTERVAL_MS ` +
        `(${config.pollIntervalMs}ms), so data refreshes slower than configured — raise the interval, ` +
        `narrow DEPARTMENTS/QUEUE_NAMES, or raise ROSTER_TTL_MS / CALL_LOG_TTL_MS.`]
      : warnings;

    latest = agentStatus.buildSnapshot(agents, all, openPeriods);
  } catch (err) {
    latest = { ...latest, warnings: [`Zoom poll failed: ${err.message}`], updatedAt: new Date().toISOString() };
  }
  return Date.now() - startedAt;
}

// Ticks are chained rather than run on a bare setInterval: a poll over a few hundred agents
// can outlast the interval, and overlapping polls would multiply Zoom traffic exactly when
// the account is already close to its rate limit.
async function runLoop(myGeneration) {
  if (inFlight) return;
  inFlight = true;
  let tookMs = 0;
  try {
    tookMs = await tick();
  } finally {
    inFlight = false;
  }
  // Pace to the interval rather than sleeping the whole interval after the poll: a 5s
  // setting with a 5.5s poll would otherwise refresh every 10.5s, not every 5s. Subtracting
  // the work already done makes POLL_INTERVAL_MS mean "how often data refreshes", and a
  // poll slower than the interval simply runs back-to-back (never overlapping, since the
  // next tick is only scheduled once this one has returned).
  const wait = Math.max(0, config.pollIntervalMs - tookMs);
  if (myGeneration === generation) timer = setTimeout(() => runLoop(myGeneration), wait);
}

function start() {
  if (timer || inFlight) return;
  runLoop(generation);
}

function stop() {
  clearTimeout(timer);
  timer = null;
  generation += 1;
}

function getSnapshot() {
  return latest;
}

module.exports = { start, stop, getSnapshot };
