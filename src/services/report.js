// Builds the Opt-In/Opt-Out report payload (single agent or whole team) from the event
// store that optOutTracker.js has been building up over the day.
const store = require('./eventStore');
const { REASONS, canonicalReason } = require('./reasons');
const { hhmm } = require('../time');

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function hm(mins) {
  const m = Math.max(0, Math.round(mins));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function durationMins(start, end) {
  return Math.max(0, toMinutes(end) - toMinutes(start));
}

function byReason(periods) {
  const totals = {};
  const counts = {};
  REASONS.forEach(r => { totals[r] = 0; counts[r] = 0; });
  for (const p of periods) {
    const r = canonicalReason(p.reason);
    totals[r] = (totals[r] || 0) + durationMins(p.start, p.end);
    counts[r] = (counts[r] || 0) + 1;
  }
  return REASONS.map(r => ({ reason: r, total: totals[r], totalLabel: hm(totals[r]), count: counts[r] }));
}

function agentRow(name, rec, nowHHMM) {
  const closedPeriods = rec.periods;
  const openPeriod = rec.open ? [{ ...rec.open, end: nowHHMM }] : [];
  const periods = closedPeriods.concat(openPeriod);

  const totalOptOutMins = periods.reduce((t, p) => t + durationMins(p.start, p.end), 0);
  const login = rec.login;
  const logout = rec.lastSeen || nowHHMM;
  const loginMins = login ? durationMins(login, logout) : 0;
  const optedInMins = Math.max(0, loginMins - totalOptOutMins);

  return {
    name,
    ext: rec.ext,
    login,
    logout: login ? logout : null,
    loginWindow: login ? `${login} – ${logout}` : '—',
    totalLoginLabel: hm(loginMins),
    totalOptedInLabel: hm(optedInMins),
    totalOptedOutLabel: hm(totalOptOutMins),
    totalOptedOutMins: totalOptOutMins,
    periodCount: periods.length,
    reasonsUsed: Array.from(new Set(periods.map(p => canonicalReason(p.reason)))).join(', ') || '—',
    byReason: byReason(periods),
    sessions: periods.map((p, i) => ({
      idx: i + 1,
      start: p.start,
      end: p.end,
      durationLabel: hm(durationMins(p.start, p.end)),
      reason: canonicalReason(p.reason),
    })),
  };
}

/**
 * @param {string} date        YYYY-MM-DD
 * @param {string} agentName   an agent's name, or 'All agents'
 */
function getReport(date, agentName, rosterNames) {
  const day = store.getDay(date);
  const now = hhmm();

  // Include every roster agent even if they generated no events yet today, so the "All
  // agents" view and the agent picker stay complete.
  const names = new Set([...(rosterNames || []), ...Object.keys(day)]);
  const rows = Array.from(names)
    .map(name => agentRow(name, day[name] || { ext: '', login: null, lastSeen: null, periods: [], open: null }, now))
    .sort((a, b) => b.totalOptedOutMins - a.totalOptedOutMins);

  const teamOptedOutMins = rows.reduce((t, r) => t + r.totalOptedOutMins, 0);
  const teamLoginMins = rows.reduce((t, r) => t + toMinutes0(r.totalLoginLabel), 0);
  const teamByReason = byReason(rows.flatMap(r => r.sessions));
  const longest = rows[0] || null;

  // Team-wide stats (avg/longest/reason totals) are shown in the filter bar regardless of
  // whether a single agent or "All agents" is selected, so they're always attached.
  const team = {
    totalOptedOutLabel: hm(teamOptedOutMins),
    totalLoginLabel: hm(teamLoginMins),
    totalOptedInLabel: hm(Math.max(0, teamLoginMins - teamOptedOutMins)),
    avgPerAgentLabel: hm(rows.length ? teamOptedOutMins / rows.length : 0),
    longest: longest ? { name: longest.name, label: longest.totalOptedOutLabel } : null,
    byReason: teamByReason,
    agentCount: rows.length,
  };

  const agentOptions = ['All agents', ...rows.map(r => r.name)];

  if (agentName && agentName !== 'All agents') {
    const single = rows.find(r => r.name === agentName) || null;
    return { scope: 'single', date, agent: single, agentOptions, team };
  }

  return { scope: 'all', date, rows, agentOptions, team };
}

// totalLoginLabel is already an "Xh YYm" string on each row; sum by re-parsing rather than
// threading raw minutes through the whole row shape.
function toMinutes0(label) {
  const m = /^(\d+)h (\d+)m$/.exec(label);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

module.exports = { getReport };
