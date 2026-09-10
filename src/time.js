// Every date and time this app records or reports is UK wall-clock time (BST in summer,
// GMT in winter) — see config.timeZone. Nothing here should use the server's own local
// zone or bare UTC: `data/events.json` is keyed by date and holds "HH:MM" strings, so a
// server running in a different zone would otherwise file today's events under the wrong
// day and label them with the wrong clock time.
//
// Intl does the DST arithmetic, so this stays right across the March/October switches
// without a lookup table. formatToParts (rather than reading the formatted string) keeps
// the output independent of how any given locale orders or punctuates a date.
const config = require('./config');

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timeZone,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23', // 00:xx at midnight, not 24:xx
});

function partsOf(fmt, d) {
  const out = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}
/** Today's date in UK time as YYYY-MM-DD. */
function todayISO(d = new Date()) {
  const p = partsOf(dateFmt, d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** A moment as UK wall-clock "HH:MM". */
function hhmm(d = new Date()) {
  const p = partsOf(timeFmt, d);
  return `${p.hour}:${p.minute}`;
}

const fullFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timeZone,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

/** How far ahead of UTC the zone is at this instant, in ms (+1h during BST, 0 in GMT). */
function offsetAt(ts) {
  const p = partsOf(fullFmt, new Date(ts));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - ts;
}

/**
 * Turns a UK wall-clock date + "HH:MM" back into an epoch timestamp — the inverse of
 * todayISO()/hhmm(). Used to recover a start time for opt-out periods recorded before the
 * store began keeping epoch timestamps.
 *
 * Applied twice on purpose: the first pass uses the offset at the wrong instant, which is
 * only wrong if the guess landed on the far side of a DST switch, and the second pass
 * corrects that.
 */
function epochFromLocal(dateISO, hhmmStr) {
  const naiveUTC = Date.parse(`${dateISO}T${hhmmStr}:00Z`);
  if (!Number.isFinite(naiveUTC)) return null;
  const first = naiveUTC - offsetAt(naiveUTC);
  return naiveUTC - offsetAt(first);
}

module.exports = { todayISO, hhmm, epochFromLocal, timeZone: config.timeZone };
