// Renders the Live Monitor tab (KPI cards + the two agent grids) from whatever the backend
// last cached from Zoom, and polls it on an interval.
const LiveMonitor = (() => {
  const POLL_MS = 5000;
  let timer = null;
  let clockTimer = null;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const TONE_VAR = {
    'Available': 'var(--available-dot)',
    'On Call': 'var(--oncall-dot)',
    'Waiting': 'var(--waiting-dot)',
    'On Break': 'var(--break-dot)',
    'Away': 'var(--alert-dot)',
  };

  const TONE_FG = {
    'Available': 'var(--available-fg)',
    'On Call': 'var(--oncall-fg)',
    'Waiting': 'var(--waiting-fg)',
    'On Break': 'var(--break-fg)',
    'Away': 'var(--alert-fg)',
  };

  // Per the design: a name row with the state as plain coloured mono text (no pill), one
  // mono line of call counts, then the opted-out queues as chips.
  function optedInCardHtml(a) {
    const cardClass = a.alert ? 'agent-card agent-card--alert' : 'agent-card';
    // The design reads "Abandoned call" rather than the bare state, and has no separate
    // alert footer — the wording plus the red border carry it.
    const stateText = a.alert ? 'Abandoned call' : a.state;
    const stateColor = a.alert ? 'var(--alert-fg)' : (TONE_FG[a.state] || 'var(--break-fg)');
    const queues = a.queues || [];

    // The design turns the whole calls line red once abandoned calls pile up. Skipped is
    // ours, appended to the same line rather than given a row of its own.
    // Abbreviated to keep it on one line inside a 212px card. The design's own line was
    // "N calls · N abandoned", which fit; adding a third figure spelled out in full
    // wrapped and orphaned the last word.
    const callsClass = a.missedTone === 'high' ? 'agent-calls agent-calls--high' : 'agent-calls';
    const calls = `${a.taken} calls · ${a.missed} aband · ${a.skipped ?? 0} skip`;

    return `
      <div class="${cardClass}">
        <div class="agent-top">
          <div class="agent-dot" style="background:${TONE_VAR[a.state] || 'var(--break-dot)'};"></div>
          <div class="agent-name" title="${esc(a.name)} · ${esc(a.ext)}">${esc(a.name)}</div>
          <div class="agent-state" style="color:${stateColor};">${esc(stateText)}</div>
        </div>
        <div class="${callsClass}" title="attended · abandoned · skipped (skipped = rang this agent, a colleague answered it)">${esc(calls)}</div>
        <div class="agent-queues">
          ${queues.length
            ? `<span class="agent-queues-lead">Out of</span>${queues.map(q => `<span class="queue-chip">${esc(q)}</span>`).join('')}`
            : '<span class="agent-queues-lead">In all queues</span>'}
        </div>
      </div>`;
  }

  // --- Break countdown -------------------------------------------------------------
  //
  // The server sends an absolute `endsAt`, and the browser does the counting. That's why
  // the timer moves every second even though data only refreshes every ~5s, and why it
  // can't drift out of step with the snapshot: both are derived from the same instant the
  // break started.
  //
  // It deliberately keeps counting past zero, negative and in red — a break that's run 9
  // minutes over is the thing a supervisor needs to see, and a timer that just stops at
  // 00:00 hides exactly that.
  function breakTimerHtml(t) {
    if (!t) return '';
    const remaining = t.endsAt - Date.now();
    const over = remaining < 0;
    const abs = Math.abs(remaining);
    const mm = String(Math.floor(abs / 60000)).padStart(2, '0');
    const ss = String(Math.floor((abs % 60000) / 1000)).padStart(2, '0');
    const cls = over ? 'break-timer break-timer--over' : (remaining <= 5 * 60000 ? 'break-timer break-timer--soon' : 'break-timer');
    const label = over
      ? `Over their ${Math.round(t.allowanceMs / 60000)}-minute ${t.reason.toLowerCase()} by ${mm}:${ss}`
      : `${mm}:${ss} left of a ${Math.round(t.allowanceMs / 60000)}-minute ${t.reason.toLowerCase()}`;
    return `<span class="${cls}" data-ends-at="${t.endsAt}" data-allowance="${t.allowanceMs}" title="${esc(label)}">${over ? '+' : ''}${mm}:${ss}</span>`;
  }

  // Re-renders just the countdown text in place, once a second, without touching the rest
  // of the DOM — repainting every card each second would fight with hover and selection.
  function tickBreakTimers() {
    document.querySelectorAll('.break-timer').forEach(el => {
      const endsAt = Number(el.dataset.endsAt);
      if (!endsAt) return;
      const remaining = endsAt - Date.now();
      const over = remaining < 0;
      const abs = Math.abs(remaining);
      const mm = String(Math.floor(abs / 60000)).padStart(2, '0');
      const ss = String(Math.floor((abs % 60000) / 1000)).padStart(2, '0');
      el.textContent = `${over ? '+' : ''}${mm}:${ss}`;
      el.classList.toggle('break-timer--over', over);
      el.classList.toggle('break-timer--soon', !over && remaining <= 5 * 60000);

      // The row highlight has to move with the timer, not with the 5s poll — an agent
      // crossing their allowance should light up the moment they do, not up to five
      // seconds later.
      const row = el.closest('.optout-row');
      if (row) row.classList.toggle('optout-row--over', over);
    });
  }

  function optedOutRowHtml(a) {
    // Precedence: over-break beats idle beats a normal break. An agent who has run past
    // their allowance is the most urgent thing in this list — and unlike the others it's
    // a state that keeps getting worse the longer it's missed.
    const overBreak = !!(a.breakTimer && a.breakTimer.endsAt < Date.now());
    const rowClass = overBreak
      ? 'optout-row optout-row--break optout-row--over'
      : (a.onCallOut
        ? 'optout-row optout-row--oncall'
        : (a.idle
          ? 'optout-row optout-row--idle'
          : (a.isBreak ? 'optout-row optout-row--break' : 'optout-row')));
    const dotColor = a.onCallOut
      ? 'var(--oncall-dot)'
      : (a.idle
        ? 'var(--idle-dot)'
        : (a.isBreak ? 'var(--break-dot)' : 'var(--optout-dot)'));
    const state = a.isBreak ? 'On break' : a.state;

    // The design's second line is a single sentence ("All queues · on break") rather than
    // the stacked ext/state/counts this row used to carry. Same shape here, with the real
    // queue count substituted for the design's fixed "All queues", and the counts kept as
    // a bare mono triple on the right because they're information the design's mock data
    // never had to show.
    const scope = a.outCount === 0 ? 'No queues' : (a.outCount === 1 ? '1 queue' : `${a.outCount} queues`);
    // An agent on a call says so, even while opted out of everything — they're on an
    // outbound or direct call. This line used to read "online, in none" for every idle
    // agent, which hid the difference between someone working a call and someone sitting
    // available and taking nothing.
    const reason = a.onCallOut
      ? `${scope} · on call`
      : (a.idle ? `${scope} · online, in none` : `${scope} · ${state.toLowerCase()}`);

    // Same wording and mono styling as the opted-in cards. These used to be a bare
    // "0 · 0 · 0" squeezed into a right-hand column, because the row also carried an ext
    // line, a state and a queue count and there was nothing left to give. The design's
    // simpler row freed that space, so the labels come back — a column of unlabelled
    // numbers meant nothing on its own.
    const callsClass = a.missedTone === 'high' ? 'agent-calls agent-calls--high' : 'agent-calls';
    const calls = `${a.taken} calls · ${a.missed} aband · ${a.skipped ?? 0} skip`;

    return `
      <div class="${rowClass}">
        <div class="agent-dot" style="background:${dotColor};"></div>
        <div class="agent-id">
          <div class="optout-name-row">${breakTimerHtml(a.breakTimer)}<span class="optout-name" title="${esc(a.name)} · ${esc(a.ext)}">${esc(a.name)}</span></div>
          <div class="optout-reason" title="${esc(a.outQueues)}">${esc(reason)}</div>
          <div class="${callsClass}" title="attended · abandoned · skipped (skipped = rang this agent, a colleague answered it)">${esc(calls)}</div>
        </div>
      </div>`;
  }

  function render(snapshot) {
    const { agents, kpis, warnings } = snapshot;

    const warnEl = document.getElementById('liveWarning');
    if (warnings && warnings.length) {
      warnEl.textContent = warnings.join(' · ');
      warnEl.hidden = false;
    } else {
      warnEl.hidden = true;
    }

    document.getElementById('kAvailable').textContent = kpis.available ?? 0;
    document.getElementById('kOnCall').textContent = kpis.onCall ?? 0;
    document.getElementById('kWaiting').textContent = kpis.waiting ?? 0;
    document.getElementById('kWaitingSub').textContent = (kpis.waiting ?? 0) > 0 ? 'calls currently queued' : 'no calls queued';
    document.getElementById('kIn').textContent = kpis.optedIn ?? 0;
    document.getElementById('kInSub').textContent = `of ${kpis.total ?? 0} team members`;
    document.getElementById('kOut').textContent = kpis.optedOut ?? 0;

    const alertCard = document.getElementById('kAlertCard');
    if (kpis.alerts > 0) {
      alertCard.hidden = false;
      document.getElementById('kAlerts').textContent = kpis.alerts;
    } else {
      alertCard.hidden = true;
    }

    const overCard = document.getElementById('kOverBreakCard');
    if (kpis.overBreak > 0) {
      overCard.hidden = false;
      document.getElementById('kOverBreak').textContent = kpis.overBreak;
    } else {
      overCard.hidden = true;
    }

    const idleCard = document.getElementById('kIdleCard');
    if (kpis.idle > 0) {
      idleCard.hidden = false;
      document.getElementById('kIdle').textContent = kpis.idle;
    } else {
      idleCard.hidden = true;
    }

    document.getElementById('inCount').textContent = `${agents.optedIn.length} agents`;
    document.getElementById('outCount').textContent = `${agents.optedOut.length} agents`;

    document.getElementById('optedInGrid').innerHTML = agents.optedIn.length
      ? agents.optedIn.map(optedInCardHtml).join('')
      : '<div class="empty-note">No agents opted in right now.</div>';

    // Agents needing attention float to the top of the opted-out list: over-break first,
    // then online-but-on-no-queue. Highlighting alone isn't enough when the section runs
    // to ~50 rows — the ones that matter would sit below the fold. Order is otherwise
    // left exactly as the backend sent it.
    const now = Date.now();
    // 3 over break, 2 on a call while opted out, 1 online but on no queue, 0 the rest.
    // Over-break stays top because it's a genuine alert; being on a call is information,
    // not a problem — but it belongs above the agents who are merely idle.
    const rank = a => (a.breakTimer && a.breakTimer.endsAt < now ? 3
      : (a.onCallOut ? 2 : (a.idle ? 1 : 0)));
    const outRows = agents.optedOut.slice().sort((x, y) => rank(y) - rank(x));

    document.getElementById('optedOutGrid').innerHTML = outRows.length
      ? outRows.map(optedOutRowHtml).join('')
      : '<div class="empty-note">No agents opted out right now.</div>';

    tickBreakTimers();
  }

  async function poll() {
    try {
      const snapshot = await Api.getSnapshot();
      render(snapshot);
    } catch (err) {
      const warnEl = document.getElementById('liveWarning');
      warnEl.textContent = `Couldn't load live status: ${err.message}`;
      warnEl.hidden = false;
    }
  }

  function tickClock() {
    const now = new Date();
    document.getElementById('clock').textContent =
      `${TimeZone.hhmmss(now)} ${TimeZone.abbreviation(now)}`;
    // Piggy-backs on the existing 1s clock rather than adding a second interval.
    tickBreakTimers();
  }

  function start() {
    poll();
    timer = setInterval(poll, POLL_MS);
    tickClock();
    clockTimer = setInterval(tickClock, 1000);
  }

  function stop() {
    clearInterval(timer);
    clearInterval(clockTimer);
    timer = null;
    clockTimer = null;
  }

  return { start, stop };
})();
