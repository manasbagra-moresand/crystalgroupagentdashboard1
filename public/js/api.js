// Thin fetch wrapper for the backend API. Credentials/cookies travel automatically
// (same-origin); nothing secret ever lives in this file.
const Api = (() => {
  // Where this app is mounted. These calls used to be hardcoded to "/api/...", which only
  // works when the dashboard owns the root of its domain. In production it's served under
  // /agent-availability, so those requests went to the domain root and 404'd.
  //
  // The base is derived from this script's own URL rather than from the page URL, because
  // the page URL may or may not carry a trailing slash and that changes how a relative path
  // resolves. This script is always loaded from "<root>/js/api.js", so stepping one level up
  // from it gives the root reliably either way.
  const BASE = (() => {
    const self = document.currentScript && document.currentScript.src;
    if (self) {
      const root = new URL('../', self).pathname; // ".../js/api.js" -> ".../"
      return root === '/' ? '' : root.replace(/\/$/, '');
    }
    // Fallback if currentScript isn't available: infer from the page instead.
    return window.location.pathname.replace(/\/(index\.html)?$/, '');
  })();

  async function request(path, options = {}) {
    const res = await fetch(BASE + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      credentials: 'same-origin',
    });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || `Request to ${BASE + path} failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  return {
    basePath: BASE,
    login: (username, password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    me: () => request('/api/auth/me'),
    getSnapshot: () => request('/api/dashboard/snapshot'),
    getReport: (date, agent) => request(`/api/report?date=${encodeURIComponent(date)}&agent=${encodeURIComponent(agent)}`),
  };
})();
