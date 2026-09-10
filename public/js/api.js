// Thin fetch wrapper for the backend API. Credentials/cookies travel automatically
// (same-origin); nothing secret ever lives in this file.
const Api = (() => {
  async function request(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      credentials: 'same-origin',
    });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || `Request to ${path} failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  return {
    login: (username, password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    me: () => request('/api/auth/me'),
    getSnapshot: () => request('/api/dashboard/snapshot'),
    getReport: (date, agent) => request(`/api/report?date=${encodeURIComponent(date)}&agent=${encodeURIComponent(agent)}`),
  };
})();
