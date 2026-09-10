// Renders the Opt-In/Opt-Out report tab: date/agent filters, headline stats, the
// single-agent timeline or the all-agents ranked list, and a client-side CSV export
// built from whatever's currently on screen.
const Report = (() => {
  let current = null; // last report payload fetched from the server

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function todayISO() { return TimeZone.todayISO(); }

  function initFilters() {
    const dateInput = document.getElementById('reportDate');
    if (!dateInput.value) dateInput.value = todayISO();
    dateInput.addEventListener('change', load);
    document.getElementById('reportAgent').addEventListener('change', load);
    document.getElementById('exportBtn').addEventListener('click', exportCsv);
  }

  function populateAgentOptions(options, selected) {
    const sel = document.getElementById('reportAgent');
    const current = sel.value;
    sel.innerHTML = options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
    sel.value = options.includes(selected) ? selected : (options.includes(current) ? current : options[0]);
  }

  function renderHeadline(data) {
    const isSingle = data.scope === 'single';
    const agent = data.agent;

    document.getElementById('headTotal').textContent = isSingle ? (agent ? agent.totalOptedOutLabel : '0h 00m') : data.team.totalOptedOutLabel;
    document.getElementById('loginTotal').textContent = isSingle ? (agent ? agent.totalLoginLabel : '0h 00m') : data.team.totalLoginLabel;
    document.getElementById('loginWindow').textContent = isSingle ? (agent ? agent.loginWindow : '—') : `${data.team.agentCount} agents · team total`;
    document.getElementById('optedInTotal').textContent = isSingle ? (agent ? agent.totalOptedInLabel : '0h 00m') : data.team.totalOptedInLabel;
    document.getElementById('headName').textContent = isSingle ? (agent ? agent.name : 'Agent not found') : 'All agents';
    document.getElementById('headSub').textContent = isSingle
      ? (agent ? `${agent.ext} · ${agent.periodCount} opt-out periods` : '—')
      : `${data.team.agentCount} agents · team total`;
    document.getElementById('headDate').textContent = data.date;

    document.getElementById('avgLabel').textContent = data.team.avgPerAgentLabel;
    document.getElementById('longestLabel').textContent = data.team.longest ? `${data.team.longest.name} · ${data.team.longest.label}` : '—';
  }

  function reasonCardHtml(r) {
    return `
      <div class="reason-card">
        <div class="reason-name">${esc(r.reason)}</div>
        <div class="reason-total mono">${esc(r.totalLabel)}</div>
        <div class="reason-count">${r.count} period${r.count === 1 ? '' : 's'}</div>
      </div>`;
  }

  function renderReasonPanel(data) {
    const byReason = data.scope === 'single' ? (data.agent ? data.agent.byReason : []) : data.team.byReason;
    document.getElementById('reasonGrid').innerHTML = (byReason || []).map(reasonCardHtml).join('');
  }

  function renderSingle(agent) {
    document.getElementById('singlePanel').hidden = false;
    document.getElementById('allPanel').hidden = true;
    if (!agent) {
      document.getElementById('timelineTrack').innerHTML = '';
      document.getElementById('sessionGrid').innerHTML = '<div class="empty-note">No data for this agent on this date.</div>';
      return;
    }
    const track = document.getElementById('timelineTrack');
    track.innerHTML = agent.sessions.map(s => {
      const [sh, sm] = s.start.split(':').map(Number);
      const [eh, em] = s.end.split(':').map(Number);
      const startMin = sh * 60 + sm, endMin = eh * 60 + em;
      const left = ((startMin - 480) / 600) * 100;
      const width = Math.max(0.8, ((endMin - startMin) / 600) * 100);
      return `<div class="timeline-bar" style="left:${left.toFixed(2)}%; width:${width.toFixed(2)}%;"></div>`;
    }).join('');

    document.getElementById('sessionGrid').innerHTML = agent.sessions.length
      ? agent.sessions.map(s => `
        <div class="session-row">
          <span class="session-idx">${String(s.idx).padStart(2, '0')}</span>
          <div class="session-body">
            <div class="session-range mono">${s.start} – ${s.end}</div>
            <div class="session-reason">${esc(s.reason)}</div>
          </div>
          <span class="session-dur mono">${esc(s.durationLabel)}</span>
        </div>`).join('')
      : '<div class="empty-note">No opt-out periods recorded for this agent today.</div>';
  }

  function renderAll(rows) {
    document.getElementById('singlePanel').hidden = true;
    document.getElementById('allPanel').hidden = false;
    const max = Math.max(1, ...rows.map(r => r.totalOptedOutMins));
    document.getElementById('rowsGrid').innerHTML = rows.length
      ? rows.map((r, i) => {
        const color = r.totalOptedOutMins > 180 ? 'var(--alert-dot)' : r.totalOptedOutMins > 100 ? 'var(--waiting-dot)' : '#9ab8a7';
        const width = Math.max(2, (r.totalOptedOutMins / max) * 100).toFixed(1);
        return `
          <div class="row-line">
            <span class="row-rank mono">${String(i + 1).padStart(2, '0')}</span>
            <div class="row-id">
              <div class="row-name">${esc(r.name)}</div>
              <div class="row-reasons">${esc(r.reasonsUsed)}</div>
            </div>
            <div class="row-track"><div class="row-bar" style="background:${color}; width:${width}%;"></div></div>
            <span class="row-login mono">${esc(r.totalLoginLabel)}</span>
            <span class="row-total mono">${esc(r.totalOptedOutLabel)}</span>
            <span class="row-count mono">${r.periodCount}×</span>
          </div>`;
      }).join('')
      : '<div class="empty-note">No agents to show.</div>';
  }

  function render(data) {
    current = data;
    populateAgentOptions(data.agentOptions, document.getElementById('reportAgent').value || 'All agents');
    renderHeadline(data);
    renderReasonPanel(data);
    if (data.scope === 'single') renderSingle(data.agent);
    else renderAll(data.rows);
  }

  async function load() {
    const date = document.getElementById('reportDate').value || todayISO();
    const agent = document.getElementById('reportAgent').value || 'All agents';
    try {
      const data = await Api.getReport(date, agent);
      render(data);
    } catch (err) {
      document.getElementById('sessionGrid').innerHTML = `<div class="empty-note">Couldn't load the report: ${esc(err.message)}</div>`;
    }
  }

  // --- CSV export (kept as CSV per project decision — Excel opens it natively) -----------
  function csvQuote(v) { return `"${String(v).replace(/"/g, '""')}"`; }
  function csvLine(cells) { return cells.map(csvQuote).join(','); }
  function slug(name) { return name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, ''); }

  function exportCsv() {
    if (!current) return;
    const { date, team } = current;
    const lines = [];
    let filenameSuffix;

    if (current.scope === 'single' && current.agent) {
      const a = current.agent;
      lines.push(
        ['Crystal Group – Opt-in / Opt-out report'], ['Date', date], ['Agent', a.name], ['Extension', a.ext],
        ['Logged in', a.loginWindow], ['Total login time', a.totalLoginLabel],
        ['Total opted in', a.totalOptedInLabel], ['Total opted out', a.totalOptedOutLabel], [],
        ['Total hours by reason'], ['Reason', 'Total time', 'Periods']
      );
      a.byReason.forEach(r => lines.push([r.reason, r.totalLabel, r.count]));
      lines.push(['Total', a.totalOptedOutLabel, a.periodCount], [], ['#', 'Start', 'End', 'Duration', 'Reason']);
      a.sessions.forEach(s => lines.push([s.idx, s.start, s.end, s.durationLabel, s.reason]));
      filenameSuffix = `-${slug(a.name)}`;
    } else {
      const rows = current.rows || [];
      lines.push(
        ['Crystal Group – Opt-in / Opt-out report'], ['Date', date], ['Scope', 'All agents'],
        ['Team login time', team.totalLoginLabel], ['Team opted out', team.totalOptedOutLabel],
        ['Average opted out per agent', team.avgPerAgentLabel], [],
        ['Rank', 'Agent', 'Extension', 'Login', 'Logout', 'Total login time', 'Total opted in', 'Total opted out', 'Opt-out periods']
          .concat(team.byReason.map(r => r.reason))
      );
      rows.forEach((r, i) => {
        const byReasonMap = Object.fromEntries(r.byReason.map(x => [x.reason, x.totalLabel]));
        lines.push([
          i + 1, r.name, r.ext, r.login || '—', r.logout || '—', r.totalLoginLabel, r.totalOptedInLabel,
          r.totalOptedOutLabel, r.periodCount,
        ].concat(team.byReason.map(x => byReasonMap[x.reason] || '0h 00m')));
      });
      lines.push([], ['Team total hours by reason'], ['Reason', 'Total time']);
      team.byReason.forEach(r => lines.push([r.reason, r.totalLabel]));
      lines.push(['Total', team.totalOptedOutLabel]);
      filenameSuffix = '-all-agents';
    }

    const csv = '﻿' + lines.map(csvLine).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `crystal-group-optout-${date}${filenameSuffix}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function start() {
    if (!started) { initFilters(); started = true; }
    load();
  }
  let started = false;

  return { start, reload: load };
})();
