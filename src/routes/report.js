const express = require('express');
const { requireAuth } = require('../auth/session');
const { getReport } = require('../services/report');
const poller = require('../services/poller');
const { todayISO } = require('../time');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const date = req.query.date || todayISO();
  const agent = req.query.agent || 'All agents';

  const snapshot = poller.getSnapshot();
  const roster = [...snapshot.agents.optedIn, ...snapshot.agents.optedOut].map(a => a.name);

  res.json(getReport(date, agent, roster));
});

module.exports = router;
