const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const config = require('./config');
const poller = require('./services/poller');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const reportRoutes = require('./routes/report');

const app = express();

app.use(express.json());
app.use(cookieSession({
  name: 'cg_session',
  secret: config.sessionSecret,
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 12 * 60 * 60 * 1000, // 12h shift-length session
}));

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/report', reportRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(config.port, () => {
  console.log(`Crystal Group Agent Dashboard listening on http://localhost:${config.port}`);
  if (!config.zoom.accountId || !config.zoom.clientId || !config.zoom.clientSecret) {
    console.warn('Zoom S2S OAuth credentials are not set — set ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ' +
      'ZOOM_CLIENT_SECRET in .env before the live dashboard will show real data.');
  }
  poller.start();
});
