const express = require('express');
const { requireAuth } = require('../auth/session');
const poller = require('../services/poller');

const router = express.Router();

// Always served from the poller's in-memory cache — never blocks on a live Zoom call, and
// never multiplies Zoom API traffic when several admins have the dashboard open at once.
router.get('/snapshot', requireAuth, (req, res) => {
  res.json(poller.getSnapshot());
});

module.exports = router;
