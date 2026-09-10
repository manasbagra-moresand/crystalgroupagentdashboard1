// Browser-side mirror of src/time.js: everything on screen reads in UK wall-clock time
// (BST in summer, GMT in winter), not the viewer's own zone. An admin checking the
// dashboard from outside the UK should still see the times their agents are working to,
// and the same clock the server wrote into the opt-out history.
//
// Keep TIME_ZONE in step with TIME_ZONE / config.timeZone on the server.
const TimeZone = (() => {
  const TIME_ZONE = 'Europe/London';

  const dateFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const clockFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23', // 00:xx at midnight, not 24:xx
  });

  function partsOf(fmt, d) {
    const out = {};
    for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
    return out;
  }

  /** Today's date in UK time as YYYY-MM-DD (what the date picker and /api/report expect). */
  function todayISO(d = new Date()) {
    const p = partsOf(dateFmt, d);
    return `${p.year}-${p.month}-${p.day}`;
  }

  /** UK wall-clock "HH:MM:SS" for the header clock. */
  function hhmmss(d = new Date()) {
    const p = partsOf(clockFmt, d);
    return `${p.hour}:${p.minute}:${p.second}`;
  }

  /** "BST" or "GMT", whichever is in force right now — shown next to the clock. */
  function abbreviation(d = new Date()) {
    const p = partsOf(
      new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, timeZoneName: 'short' }),
      d
    );
    return p.timeZoneName || '';
  }

  return { TIME_ZONE, todayISO, hhmmss, abbreviation };
})();
