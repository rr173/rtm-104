const express = require('express');
const router = express.Router();
const replayService = require('../services/replayService');

router.post('/start', async (req, res) => {
  try {
    const result = await replayService.startReplay(req.body);
    if (!result.success) {
      const statusCode = result.code || 400;
      return res.status(statusCode).json({ error: result.error });
    }
    res.json(result.status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const status = await replayService.getStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/stop', async (req, res) => {
  try {
    const result = await replayService.stopReplay();
    if (!result.success) {
      const statusCode = result.code || 400;
      return res.status(statusCode).json({ error: result.error });
    }
    res.json(result.status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
