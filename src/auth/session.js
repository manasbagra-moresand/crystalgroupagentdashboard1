// Cookie-session based admin auth. The credentials themselves live only in config.js and
// are compared here, server-side; the browser only ever receives a signed, httpOnly session
// cookie (no username/password/token in any client-visible payload).
const config = require('../config');

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'Not signed in' });
}

function login(req, res) {
  const { username, password } = req.body || {};
  if (username === config.adminUsername && password === config.adminPassword) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Invalid username or password' });
}

function logout(req, res) {
  req.session = null;
  res.json({ ok: true });
}

function me(req, res) {
  res.json({ authed: !!(req.session && req.session.authed) });
}

module.exports = { requireAuth, login, logout, me };
