// Builds the live "who's opted in, who's opted out, who's mid-call, who's abandoned a call"
// picture the dashboard renders, by combining several Zoom Phone/User endpoints:
//   - phone users                (the agent roster + extension numbers)
//   - call queue members         (per-queue opt-in/opt-out status, read queue-by-queue)
//   - each agent's presence      (are they actually at their desk right now)
//   - each agent's call logs     (today's attended/missed counts)
//
// Zoom doesn't expose a single "agent state" field that matches the dashboard's
// Available / On Call / Waiting / On Break / Abandoned vocabulary, so this module maps
// Zoom's raw presence value (and, where set, a free-text custom status message) onto it.
// That mapping (STATE_BY_PRESENCE below) is the piece most likely to need tuning once this
// runs against a real account — see README.md.
const config = require('../config');
const zoom = require('../zoom/client');
const { mapPool } = require('../zoom/pool');
const { UNSPECIFIED } = require('./reasons');
const { todayISO } = require('../time');

const TONE = {
  'Available': { dot: '#2f8f5b', fg: '#256e47', bg: '#e8f3ec', bd: '#c6e0d1' },
  'On Call': { dot: '#2f6fd0', fg: '#2358a8', bg: '#e9f0fb', bd: '#c8d9f2' },
  'Waiting': { dot: '#c98a1e', fg: '#9c6a10', bg: '#fbf2e2', bd: '#eeddb9' },
  'On Break': { dot: '#7a4fd0', fg: '#5b34a8', bg: '#f1ecfb', bd: '#ddd0f3' },
  'Abandoned': { dot: '#c4342a', fg: '#a52a21', bg: '#fdf2f1', bd: '#e9bcb8' },
};

// Zoom presence -> dashboard state. Values seen "at the desk" map to Available/On Call;
// anything else is treated as away. Whether "away" means On Break or Off shift is decided
// by whether they're still opted into any queue (see decorateAgent below) — someone away
// from their desk while still opted in is exactly the "abandoned call" condition this
// dashboard exists to surface.
//
// A value missing from this map is NOT a harmless no-op, which is why unmatched values are
// collected and surfaced in the snapshot warnings (see loadAllAgents). An unmatched
// presence falls through to "away", and "away" while opted into a queue is reported as
// Abandoned — so a single missing key turns working agents into red alerts. That is exactly
// what happened with phone calls: this account returns `In_A_Call`, the map only had
// `On_A_Call`, and every agent actually on a call was shown as "opted in but away".
//
// Keys are matched trimmed and lower-cased, the same discipline the call-result sets below
// use, so a difference in casing alone can't resurrect that bug.
const STATE_BY_PRESENCE = new Map(Object.entries({
  // At their desk and free to take a call.
  available: 'Available',

  // At their desk and occupied — on a call, in a meeting, presenting. Working, not
  // abandoning anything. `in_a_call` is what this account actually returns for a Zoom Phone
  // call; the rest are Zoom's documented siblings, kept so another account or plan that
  // words it differently doesn't regress into false alerts.
  in_a_call: 'On Call',
  on_a_call: 'On Call',
  on_phone_call: 'On Call',
  in_a_meeting: 'On Call',
  in_a_zoom_meeting: 'On Call',
  in_calendar_event: 'On Call',
  presenting: 'On Call',
  busy: 'On Call',

  // Away from the desk. If they're still opted into a queue this becomes the Abandoned alert.
  away: 'away',
  do_not_disturb: 'away',

  // Not on shift at all.
  offline: 'off',
  out_of_office: 'off',
}));

/** Maps a raw Zoom presence value, or returns null if this map has never heard of it. */
function mapPresence(status) {
  return STATE_BY_PRESENCE.get(norm(status)) || null;
}

// Zoom never tells us which opt-out reason an agent picked (see services/reasons.js), so
// the only hint available is a free-text custom presence status, when they've set one.
// This is a best-effort match onto Zoom's four reasons; returning null (→ "Unspecified")
// is a perfectly good outcome and better than a confident guess.
//
// Matched on whole words against a synonym list rather than by raw substring. The previous
// version took each reason's first word and did an `includes`, which for "End Shift" means
// testing for "end" — that matches "attending", "weekend" and "pending", and would file
// someone in a meeting under End Shift.
const REASON_SYNONYMS = [
  ['Break', ['break', 'tea', 'coffee', 'brb', 'comfort']],
  ['Meal', ['meal', 'lunch', 'dinner', 'breakfast', 'food', 'eating']],
  ['Training', ['training', 'train', 'coaching', 'course', 'onboarding']],
  ['End Shift', ['end shift', 'end of shift', 'shift over', 'shift end', 'finished', 'logged off', 'off shift']],
];

function reasonFromStatusMessage(message) {
  if (!message) return null;
  const text = norm(message);
  for (const [reason, synonyms] of REASON_SYNONYMS) {
    // \b so "tea" doesn't match "steam" and "break" doesn't match "breakthrough".
    if (synonyms.some(s => new RegExp(`\\b${s.replace(/ /g, '\\s+')}\\b`, 'i').test(text))) {
      return reason;
    }
  }
  return null;
}

// Best-effort "a call is ringing this agent right now", used to show the Waiting state.
//
// Caveat worth knowing before trusting this: a call only appears in the call log once it has
// already finished, and every logged entry therefore carries a terminal result ("Call
// connected", "No Answer", …). There is no "ringing now" value to look for — the previous
// version of this function searched for results containing "ring" or "queue", which this
// account never produces, so Waiting was permanently unreachable and Calls Waiting sat at 0.
//
// What's left is a narrow inference: an inbound call that was logged in the last few seconds
// and connected may still be in progress. A `phone.callee_ringing` webhook, or Zoom Contact
// Center's real-time queue metrics, is the only accurate source for live queue depth — see
// README.md.
function isLikelyRinging(callLogs, windowMs) {
  const cutoff = Date.now() - windowMs;
  return callLogs.some(c => {
    if (String(c.direction || '').toLowerCase() !== 'inbound') return false;
    const started = Date.parse(c.date_time || c.start_time || '');
    if (!Number.isFinite(started) || started < cutoff) return false;
    // Came in via a call queue and hasn't been given a duration yet.
    const viaQueue = c.forwarded_by && c.forwarded_by.extension_type === 'callQueue';
    return viaQueue && !Number(c.duration);
  });
}

// Zoom's `result` strings, mapped explicitly. These are matched exactly (after trimming and
// lower-casing) rather than by substring, because substring matching gets this dangerously
// wrong: "No Answer" contains "answer", so an `includes('answer')` test counts every missed
// call as an attended one — on a dashboard whose entire purpose is surfacing missed and
// abandoned calls.
//
// Values confirmed present on the live account: "Call connected", "Auto Recorded",
// "No Answer", "Call Cancel", "Busy". The rest are Zoom result strings this account hasn't
// produced yet but that are documented/observed elsewhere; unknown values fall back to
// duration and are reported so they can be added here deliberately.
const RESULT_TAKEN = new Set([
  'call connected',
  'connected',
  'auto recorded',
  'answered',
  'call answered',
]);

const RESULT_MISSED = new Set([
  'no answer',
  'busy',
  'call cancel',
  'call cancelled',
  'cancelled',
  'canceled',
  'voicemail',
  'call recorded voicemail',
  'rejected',
  'call rejected',
  'blocked',
  'missed',
  'abandoned',
  'hang up',
  // Surfaced by the unmapped-value warning once this ran at a 5s cadence: a call that
  // failed never reached the agent, so it counts against them the same way "No Answer" does.
  'call failed',
]);

// Skipped: the call rang this agent and a colleague picked it up instead.
//
// Confirmed on the live account — these entries carry `duration: 0`, a non-zero
// `waiting_time` (how many seconds it rang them), `forwarded_by.extension_type:
// "callQueue"`, and an `accepted_by` naming who actually took it. 92 of them in three days.
//
// This used to be counted against neither total, on the reasoning that it says nothing
// about the agent either way. That's right for the attended/abandoned split — crediting it
// as taken would reward work they didn't do, counting it missed would punish everyone on a
// shared queue whenever a colleague was quicker — but it is not nothing: it is exactly
// "an incoming call this agent let go by", which is worth showing on its own.
const RESULT_SKIPPED = new Set([
  'answered by other member',
  'call connected by other member',
]);

// Counted against nothing at all. The live account produces ~15 inbound entries with an
// empty result over three days; with no result and no duration there's nothing to infer.
const RESULT_IGNORED = new Set([
  '',
]);

/**
 * Counts today's inbound calls for one agent as attended vs missed.
 *
 * Returns the `result` values it couldn't classify so the caller can surface them — an
 * unmapped value silently guessed at is how this went wrong in the first place.
 */
function countAttendedAndMissed(callLogs) {
  let taken = 0;
  let missed = 0;
  let skipped = 0;
  const unknown = new Set();

  for (const c of callLogs) {
    if (String(c.direction || '').toLowerCase() !== 'inbound') continue;
    const result = String(c.result || '').trim().toLowerCase();

    if (RESULT_IGNORED.has(result)) continue;
    if (RESULT_SKIPPED.has(result)) skipped += 1;
    else if (RESULT_TAKEN.has(result)) taken += 1;
    else if (RESULT_MISSED.has(result)) missed += 1;
    else {
      // Unmapped result: a call that lasted no time at all was not attended. Best-effort,
      // and recorded as unknown so the mapping above can be corrected.
      unknown.add(String(c.result || '(empty)'));
      if (Number(c.duration) > 0) taken += 1;
      else missed += 1;
    }
  }

  return { taken, missed, skipped, unknown };
}

const norm = s => String(s || '').trim().toLowerCase();

/**
 * Is this phone user part of the business unit the dashboard is scoped to (DEPARTMENTS)?
 *
 * Zoom phone users have no "group" field — the only business-unit fields on the object are
 * `department` and `cost_center` — so a user matches if *either* one does. On the live
 * account those two agree for everyone but a single person (one agent sits in the
 * "Earls Court" department on the "Crystal UK" cost centre), and matching either is what
 * keeps them in scope.
 *
 * Comparison is trimmed and case-insensitive because the account has hand-typed variants
 * ("Crystal UK", "Crystal Uk", "Crystal UK "). It's deliberately exact-after-normalising
 * rather than a substring match, so scoping to "Crystal UK" does not also drag in
 * "Crystal US" or the bare "Crystal" entries.
 */
function inScope(user) {
  const wanted = config.departmentFilter;
  if (!wanted.length) return true;
  return wanted.includes(norm(user.department)) || wanted.includes(norm(user.cost_center));
}

// Which queues are worth polling. Reading members of all ~190 queues every few seconds is
// the single most expensive thing this app can do, and only ~33 of them contain any Crystal
// UK agent, so the full sweep runs on a slow discovery interval and the frequent polls only
// revisit the queues that actually matter. Queue *membership* changes when someone is added
// to a queue (rare); opt-in/opt-out within a queue changes constantly, and that's what the
// frequent poll is for.
let queueScope = { at: 0, ids: null };

async function resolveQueues(allQueues) {
  const wanted = config.queueNameFilter;
  if (wanted.length) {
    const names = wanted.map(norm);
    const queues = allQueues.filter(q => names.includes(norm(q.name)));
    const missing = wanted.filter(w => !allQueues.some(q => norm(q.name) === norm(w)));
    return {
      queues,
      full: false,
      warnings: missing.length ? [`QUEUE_NAMES lists queue(s) that don't exist on this Zoom account: ${missing.join(', ')}`] : [],
    };
  }

  const fresh = queueScope.ids && (Date.now() - queueScope.at) < config.queueDiscoveryMs;
  if (fresh) {
    return { queues: allQueues.filter(q => queueScope.ids.has(q.id)), full: false, warnings: [] };
  }
  // Discovery sweep: look at every queue, and remember which ones held an in-scope agent.
  return { queues: allQueues, full: true, warnings: [] };
}

/**
 * Zoom has no "list this user's call queues" endpoint, so membership is read per queue and
 * inverted here into a per-user view: userId -> { in: [queueName], out: [queueName] }.
 *
 * Only members in `inScopeIds` are kept, so the returned map is already the dashboard's
 * agent roster: an in-scope user who is on no queue at all isn't a contact-centre agent and
 * doesn't appear.
 */
async function loadQueueMembership(inScopeIds) {
  const allQueues = await cachedCallQueues();
  const { queues, full, warnings } = await resolveQueues(allQueues);

  const memberships = await mapPool(queues, config.zoomConcurrency, async q => {
    try {
      return { queue: q, members: await zoom.listCallQueueMembers(q.id) };
    } catch {
      return { queue: q, members: null };
    }
  });

  const byUser = new Map();
  const relevantIds = new Set();
  let failedQueues = 0;

  for (const { queue, members } of memberships) {
    if (!members) { failedQueues += 1; continue; }
    for (const m of members) {
      // Queues can also contain common-area phones; only real users are agents.
      if (m.level && m.level !== 'user') continue;
      if (!inScopeIds.has(m.id)) continue;
      relevantIds.add(queue.id);
      if (!byUser.has(m.id)) byUser.set(m.id, { in: [], out: [] });
      byUser.get(m.id)[m.receive_call ? 'in' : 'out'].push(queue.name);
    }
  }

  // Only a full sweep is allowed to define the narrowed set — a narrowed poll can't discover
  // a queue it didn't look at, and must not shrink the scope to whatever it happened to see.
  if (full && !failedQueues) queueScope = { at: Date.now(), ids: relevantIds };

  if (failedQueues) warnings.push(`${failedQueues} of ${queues.length} call queue(s) failed to load members this poll`);
  if (!queues.length) warnings.push('No call queues in scope — the dashboard has no agents to show.');

  return { byUser, queueCount: queues.length, warnings };
}

/**
 * Shapes one agent's live status from data already fetched. Presence is passed in rather
 * than fetched here so the presence sweep can run concurrently with queue membership —
 * they depend on nothing but the in-scope user ids.
 */
function loadAgent(user, membership, callLogs, presence) {
  const outQueues = membership.out;
  const optedIn = membership.in.length > 0;

  // An unrecognised presence value still has to resolve to something, and "away" is the
  // safe default (it can only ever over-report the alert this dashboard exists to raise,
  // never hide it) — but it's reported rather than assumed correct.
  const known = mapPresence(presence.status);
  const mapped = known || 'away';

  let state;
  if (mapped === 'On Call' || mapped === 'Available') {
    state = mapped === 'Available' && isLikelyRinging(callLogs, 20_000) ? 'Waiting' : mapped;
  } else if (optedIn) {
    // Opted into at least one queue but not actually at their desk: the alert case.
    state = 'Abandoned';
  } else {
    state = mapped === 'off' ? 'Off shift' : 'On Break';
  }

  const { taken, missed, skipped, unknown } = countAttendedAndMissed(callLogs);

  return {
    id: user.id,
    unknownResults: unknown,
    unknownPresence: known ? null : String(presence.status || '(empty)'),
    name: user.name || `${user.first_name || ''} ${user.last_name || ''}`.trim(),
    ext: user.extension_number ? `Ext ${user.extension_number}` : '',
    in: optedIn, // Abandoned agents keep `in: true` here — the UI treats Abandoned as an alert layered on top of "opted in"
    state,
    // "Away" used to be the fallback here, but it isn't one of Zoom's reasons — it just
    // restated the state. Unattributable time says so instead.
    reason: state === 'On Break' ? (reasonFromStatusMessage(presence.statusMessage) || UNSPECIFIED) : null,
    taken,
    missed,
    skipped,
    outQueueNames: outQueues,
  };
}

// States that mean the agent is at their desk and working right now.
const AT_DESK_STATES = new Set(['Available', 'On Call', 'Waiting']);

function decorateAgent(a) {
  const alert = a.state === 'Abandoned';

  // Online and working, but opted out of every queue they belong to, so no queue call can
  // reach them. This is the mirror image of Abandoned — there the agent is opted in and
  // absent; here they're present and opted out — and it's just as invisible without a
  // flag, because the row otherwise reads as an unremarkable "Available".
  //
  // Not necessarily wrong (someone may be on admin work by arrangement), so it's surfaced
  // as capacity to look at rather than as an error.
  const idle = !a.in && AT_DESK_STATES.has(a.state);

  // Opted out of every queue but demonstrably on a call — an outbound dial, or a direct
  // inbound one that bypassed the queues. Worth separating from the plain idle case: this
  // agent is visibly working, they just can't be reached through a queue, whereas a plain
  // idle agent is sitting available and taking nothing. Surfaced above the idle rows.
  const onCallOut = idle && a.state === 'On Call';

  const t = TONE[a.state] || TONE['On Break'];
  const q = a.outQueueNames || [];
  return {
    name: a.name,
    ext: a.ext,
    taken: a.taken,
    missed: a.missed,
    skipped: a.skipped,
    alert,
    idle,
    onCallOut,
    state: alert ? 'Away' : a.state,
    outCount: q.length,
    outLabel: q.length === 0 ? 'No queues opted out' : (q.length === 1 ? '1 queue opted out' : `${q.length} queues opted out`),
    // Both shapes: the array drives the design's per-queue chips, the joined string is the
    // hover title (and the compact opted-out rows, which have no room for chips).
    queues: q,
    outQueues: q.length ? q.join(' · ') : '—',
    outStyle: q.length >= 3 ? 'warn' : 'muted',
    cardTone: alert ? 'alert' : (a.state === 'On Break' ? 'break' : 'normal'),
    dotColor: t.dot,
    badgeFg: t.fg,
    badgeBg: t.bg,
    badgeBd: t.bd,
    missedTone: a.missed >= 3 ? 'high' : a.missed > 0 ? 'mid' : 'low',
    // Skipping a queue call is normal on a shared queue — a colleague simply got there
    // first — so this only starts colouring at a level that suggests a pattern, and never
    // reaches the red reserved for genuinely abandoned calls.
    skippedTone: a.skipped >= 5 ? 'mid' : 'low',
  };
}

// --- Caches for the slow-changing halves of a poll -------------------------------------
//
// At a 5s poll interval most of a tick was being spent re-fetching things that barely
// change. Measured against the live account, per tick: phone users 3.9s, call queues 0.8s,
// call logs 10.3s — against presence at 3.7s and queue membership at 3.6s, which are the
// only parts that are actually "live". Caching the first group is what makes a 5s cadence
// possible at all; raising ZOOM_CONCURRENCY does not (measured: a 60-agent presence sweep
// takes 3.2s at concurrency 8 and 4.6s at 40 — Zoom, not our parallelism, is the limit).

let rosterCache = { at: 0, users: null };
let queueListCache = { at: 0, queues: null };

async function cachedPhoneUsers() {
  if (rosterCache.users && Date.now() - rosterCache.at < config.rosterTtlMs) return rosterCache.users;
  const users = await zoom.listPhoneUsers();
  rosterCache = { at: Date.now(), users };
  return users;
}

async function cachedCallQueues() {
  if (queueListCache.queues && Date.now() - queueListCache.at < config.rosterTtlMs) return queueListCache.queues;
  const queues = await zoom.listCallQueues();
  queueListCache = { at: Date.now(), queues };
  return queues;
}

// userId -> { at, date, logs }. Keyed by date too, so the day rolling over invalidates
// everything rather than serving yesterday's counts.
const callLogCache = new Map();

/**
 * Tops up the call-log cache, refreshing only what's gone stale and capping how much is
 * refreshed per tick.
 *
 * The cap is the point: with one TTL and no cap, every agent's entry expires on the same
 * tick (they were all fetched together), so one poll in twelve would pay the full ~10s and
 * blow through the interval. Refreshing the oldest `agents × interval / TTL` each tick
 * spreads that same work evenly — about 5 agents, ~0.9s, per tick at the defaults.
 */
async function refreshCallLogs(roster, today) {
  const now = Date.now();
  const entryFor = id => {
    const e = callLogCache.get(id);
    return e && e.date === today ? e : null;
  };

  // Cold start: nothing cached yet, so fetch everyone once rather than dribbling the
  // counts in over the first minute.
  const cold = roster.filter(({ user }) => !entryFor(user.id));
  const stale = roster
    .filter(({ user }) => {
      const e = entryFor(user.id);
      return e && now - e.at >= config.callLogTtlMs;
    })
    .sort((a, b) => entryFor(a.user.id).at - entryFor(b.user.id).at);

  const perTick = Math.max(1, Math.ceil(roster.length * config.pollIntervalMs / config.callLogTtlMs));
  const batch = cold.length ? cold : stale.slice(0, perTick);

  await mapPool(batch, config.zoomConcurrency, async ({ user }) => {
    const logs = await zoom.getUserCallLogs(user.id, today, today).catch(() => null);
    // A failed fetch keeps the previous logs rather than zeroing the agent's counts, but
    // still stamps the time so one broken user can't be retried every single tick.
    callLogCache.set(user.id, {
      at: Date.now(),
      date: today,
      logs: logs || entryFor(user.id)?.logs || [],
    });
  });
}

/** Presence for every in-scope user, as a Map. */
async function loadPresence(userIds) {
  const entries = await mapPool(userIds, config.zoomConcurrency, async id => {
    const p = await zoom.getUserPresence(id).catch(() => ({ status: 'Offline', statusMessage: null }));
    return [id, p];
  });
  return new Map(entries);
}

// Call logs need their own OAuth scope (phone:read:list_call_logs:admin). If the Zoom app
// wasn't granted it, every per-agent call-log request 400s — hundreds of guaranteed-failing
// requests per tick. Probe once, then stop asking and say so in the snapshot instead.
let callLogsAvailable = null; // null = not yet probed, true/false = known

async function probeCallLogs(sampleUserId, today) {
  if (callLogsAvailable !== null) return callLogsAvailable;
  if (!sampleUserId) return true; // nothing to probe with; find out on the next poll
  try {
    // One agent's logs for one day — cheap enough to spend on finding out.
    await zoom.getUserCallLogs(sampleUserId, today, today);
    callLogsAvailable = true;
  } catch (err) {
    // Only a missing scope is permanent. Anything else (a 429, a blip) must not switch call
    // stats off for the life of the process.
    callLogsAvailable = !err.missingScope;
  }
  return callLogsAvailable;
}

/**
 * Fetches raw per-agent status from Zoom. This is the only function in the app that actually
 * calls out to Zoom for live status — both the dashboard's cached snapshot and the opt-out
 * event tracker are built from a single call to this per poll tick, so opening more browser
 * tabs never multiplies Zoom API traffic.
 *
 * A steady-state tick costs roughly `queues-in-scope + in-scope users + a slice of agents`
 * Zoom requests, all funnelled through mapPool at ZOOM_CONCURRENCY. The phone-user roster,
 * the call-queue list and most call logs come from cache (see the cache block above), which
 * is what keeps the tick inside a 5s interval.
 */
async function loadAllAgents() {
  // The UK date, so "today's calls" means the agents' working day rather than a UTC one —
  // between midnight and 01:00 BST those are different dates.
  const today = todayISO();

  const allUsers = await cachedPhoneUsers();
  const users = allUsers.filter(inScope);

  const warnings = [];
  if (config.departmentFilter.length && !users.length) {
    warnings.push(`No phone users are in department/cost centre: ${config.departmentFilter.join(', ')}. ` +
      'Check DEPARTMENTS against the values on your Zoom phone users.');
  }

  const usersById = new Map(users.map(u => [u.id, u]));

  // Queue membership and presence are the two genuinely live signals, and neither depends
  // on the other — both need only the in-scope user ids. Run together they cost about as
  // long as the slower one (~4s) instead of their sum (~7s), which is the difference
  // between fitting in a 5s tick and not.
  const [membership, presenceById] = await Promise.all([
    loadQueueMembership(new Set(usersById.keys())),
    loadPresence([...usersById.keys()]),
  ]);
  warnings.push(...membership.warnings);

  // The roster is exactly the in-scope users who are on at least one call queue. Someone in
  // the department but on no queue isn't a contact-centre agent and isn't shown.
  const roster = [...membership.byUser].map(([userId, m]) => ({ user: usersById.get(userId), membership: m }));

  const withCallLogs = await probeCallLogs(roster.length ? roster[0].user.id : null, today);
  if (!withCallLogs) {
    warnings.push('Calls taken/missed unavailable: the Zoom app is missing the call log scope ' +
      '(phone:read:list_call_logs:admin). Everything else is live.');
  }

  if (withCallLogs) await refreshCallLogs(roster, today);

  const settled = roster.map(({ user, membership: m }) => {
    try {
      const cached = callLogCache.get(user.id);
      const callLogs = (cached && cached.date === today) ? cached.logs : [];
      const presence = presenceById.get(user.id) || { status: 'Offline', statusMessage: null };
      return loadAgent(user, m, callLogs, presence);
    } catch {
      return null;
    }
  });

  const agents = settled.filter(Boolean);
  const failedCount = settled.length - agents.length;
  if (failedCount) warnings.push(`${failedCount} agent(s) failed to load from Zoom this poll`);

  // Any call `result` value that isn't in RESULT_TAKEN/RESULT_MISSED was counted by duration
  // as a guess. Say so, with the actual values, so the mapping can be corrected rather than
  // quietly skewing the attended/missed split.
  const unmapped = new Set();
  for (const a of agents) {
    if (a.unknownResults) for (const r of a.unknownResults) unmapped.add(r);
  }
  if (unmapped.size) {
    warnings.push(`Unmapped Zoom call result value(s), counted by call duration as a fallback: ` +
      `${[...unmapped].join(', ')} — add them to RESULT_TAKEN/RESULT_MISSED in services/agentStatus.js.`);
  }

  // Same idea for presence, and higher stakes: an unmapped presence value is treated as
  // "away", so every agent on it who is opted into a queue is being reported as Abandoned.
  // Say which value it is rather than letting it show up as a wave of false red alerts.
  const unmappedPresence = new Set();
  for (const a of agents) {
    if (a.unknownPresence) unmappedPresence.add(a.unknownPresence);
  }
  if (unmappedPresence.size) {
    warnings.push(`Unrecognised Zoom presence value(s): ${[...unmappedPresence].join(', ')} — ` +
      `agents on them are being treated as away, which shows them as "Abandoned" if they're ` +
      `opted into a queue. Add them to STATE_BY_PRESENCE in services/agentStatus.js.`);
  }

  return { agents, warnings };
}

/**
 * How much of a break allowance this agent has left, or null if their opt-out doesn't
 * carry one. `endsAt` is an absolute epoch time rather than a remaining duration so the
 * browser can tick the countdown every second without the server re-sending it, and so a
 * snapshot sitting in a tab for a few seconds doesn't show a stale figure.
 */
function breakTimer(agent, openPeriods) {
  const open = openPeriods && openPeriods.get(agent.name);
  if (!open || !open.openedAt) return null;

  // The allowance depends on why they're away — a Break is shorter than a Meal — so it's
  // looked up per reason. A reason with no configured allowance gets no countdown.
  const allowanceMs = config.breakAllowances[open.reason];
  if (!allowanceMs) return null;

  return {
    reason: open.reason,
    startedAt: open.openedAt,
    endsAt: open.openedAt + allowanceMs,
    allowanceMs,
  };
}

/** Decorates a raw agent list (from loadAllAgents) into the shape the dashboard renders. */
function buildSnapshot(agents, warnings = [], openPeriods = null) {
  const optedIn = agents.filter(a => a.in && a.state !== 'On Break').map(decorateAgent);
  const optedOut = agents.filter(a => !a.in || a.state === 'On Break').map(a => ({
    ...decorateAgent(a),
    isBreak: a.state === 'On Break',
    reasonLabel: a.reason,
    // Only agents actually on a break get a countdown. Someone opted out at their desk
    // (the "Online, No Queue" case) or off shift isn't on a timed break, even though the
    // tracker has an open opt-out period for them too.
    breakTimer: a.state === 'On Break' ? breakTimer(a, openPeriods) : null,
  }));

  const alerts = optedIn.filter(a => a.alert).length;
  const waiting = optedIn.filter(a => a.state === 'Waiting').length;
  // Online but opted out of every queue — counted off the opted-out list, which is where
  // decorateAgent's `idle` can be true (an opted-in agent is never idle by definition).
  const idle = optedOut.filter(a => a.idle).length;

  // Counted across the whole roster, not just the opted-in half: someone on a call is on a
  // call whether or not they're opted into a queue (an opted-out agent still takes direct
  // calls, and shows as "On Call" in the Opted Out list). Note this is a different basis
  // from `available` below, which is deliberately opted-in-only — an opted-out agent is not
  // "free to take a call" in the sense that card means.
  const onCall = [...optedIn, ...optedOut].filter(a => a.state === 'On Call').length;

  // Agents past their break allowance. The browser re-evaluates this every second off the
  // same `endsAt`, so the row highlight is instant; this count is what the KPI card shows
  // and is only as fresh as the poll.
  const now = Date.now();
  const overBreak = optedOut.filter(a => a.breakTimer && a.breakTimer.endsAt < now).length;

  return {
    agents: { optedIn, optedOut },
    kpis: {
      available: optedIn.filter(a => a.state === 'Available').length,
      onCall,
      waiting,
      optedIn: optedIn.length,
      optedOut: optedOut.length,
      total: agents.length,
      alerts,
      idle,
      overBreak,
    },
    warnings,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { loadAllAgents, loadQueueMembership, buildSnapshot, decorateAgent, TONE };
