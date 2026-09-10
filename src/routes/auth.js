const express = require('express');
const session = require('../auth/session');

const router = express.Router();

router.post('/login', session.login);
router.post('/logout', session.logout);
router.get('/me', session.me);

module.exports = router;
