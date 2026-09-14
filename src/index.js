const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const config = require('./config');
const poller = require('./services/poller');
const eventStore = require('./services/eventStore');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const reportRoutes = require('./routes/report');

const app = express();

// Everything the app serves hangs off this, so one build works both at the root of a domain
// (local, Docker) and under a sub-path behind a reverse proxy. Production sits at
// /agent-availability and the proxy forwards that prefix rather than stripping it, so
// without this the app 404s every request including its own assets.
const BASE = config.basePath;

// Behind a proxy, trust its X-Forwarded-* headers so req.protocol and req.secure reflect
// the original HTTPS request rather than the plain HTTP hop from the proxy. Without it the
// session cookie's `secure` flag can't be set correctly.
app.set('trust proxy', true);

app.use(express.json());
app.use(cookieSession({
  name: 'cg_session',
  secret: config.sessionSecret,
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 12 * 60 * 60 * 1000, // 12h shift-length session
  // Scope the cookie to the mount point. At the root this is "/" as before; under a
  // sub-path it stops this app's session cookie being sent to every other app on the
  // same hostname — dubs.gcm-online.co serves more than this one.
  path: BASE || '/',
}));

// A request to the mount point with no trailing slash ("/agent-availability") must be
// redirected to "/agent-availability/". index.html references its assets relatively
// ("./css/styles.css"), and a browser resolves those against the *directory* of the current
// URL — without the trailing slash that directory is the domain root, so every stylesheet,
// script and image would 404. Serving the page at both spellings is not enough; the URL in
// the address bar is what the browser resolves against.
if (BASE) {
  app.get(BASE, (req, res) => res.redirect(301, BASE + '/'));
}

// Mounted on a router rather than directly on `app` so the prefix is applied in one place
// and the route definitions below stay path-agnostic.
const router = express.Router();

router.use('/api/auth', authRoutes);
router.use('/api/dashboard', dashboardRoutes);
router.use('/api/report', reportRoutes);

router.use(express.static(path.join(__dirname, '..', 'public')));

app.use(BASE || '/', router);

const server = app.listen(config.port, () => {
  console.log(`Crystal Group Agent Dashboard listening on http://localhost:${config.port}`);
  if (!config.zoom.accountId || !config.zoom.clientId || !config.zoom.clientSecret) {
    console.warn('Zoom S2S OAuth credentials are not set — set ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ' +
      'ZOOM_CLIENT_SECRET in .env before the live dashboard will show real data.');
  }
  poller.start();
});

// Container runtimes stop a process by sending SIGTERM and SIGKILLing it a few seconds
// later, so shutdown has to be deliberate: stop the poll loop, write the event store out
// (its saves are debounced by a second — see services/eventStore.js), then close the
// listener. Without this a redeploy silently drops the last second of opt-out history.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down.`);

  poller.stop();
  console.log(eventStore.flush() ? 'Event store flushed to disk.' : 'Event store flush FAILED.');

  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  // A poll can be mid-flight against Zoom and keeps a socket open; don't hang past the
  // runtime's grace period waiting for it.
  setTimeout(() => {
    console.warn('Shutdown timed out after 8s — exiting anyway.');
    process.exit(0);
  }, 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
