const express = require('express');
const router = express.Router();
const pollingService = require('../services/pollingService');

router.post('/config', async (req, res) => {
  try {
    const result = await pollingService.setPollingConfig(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result.config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/config', async (req, res) => {
  try {
    res.json(await pollingService.getAllConfigs());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/config/:deviceId', async (req, res) => {
  try {
    const config = await pollingService.getConfig(req.params.deviceId);
    if (!config) {
      return res.status(404).json({ error: '轮询配置不存在' });
    }
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/status', (req, res) => {
  res.json(pollingService.getAllStatus());
});

module.exports = router;
