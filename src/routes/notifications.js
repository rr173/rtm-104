const express = require('express');
const router = express.Router();
const notificationService = require('../services/notificationService');

router.get('/stats', async (req, res) => {
  try {
    res.json(await notificationService.getStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    res.json(await notificationService.getNotifications(status));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
