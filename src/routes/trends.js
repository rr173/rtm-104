const express = require('express');
const router = express.Router();
const trendService = require('../services/trendService');

router.post('/config', async (req, res) => {
  try {
    const result = await trendService.createConfig(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/config', async (req, res) => {
  try {
    res.json(await trendService.getAllConfigs());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/config/:id', async (req, res) => {
  try {
    const deleted = await trendService.deleteConfig(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: '配置不存在' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    res.json(await trendService.getStatsSnapshot());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/anomalies', async (req, res) => {
  try {
    const { deviceId, limit } = req.query;
    res.json(await trendService.getAnomalies(deviceId, limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/curve/:deviceId/:regAddress', async (req, res) => {
  try {
    const { deviceId, regAddress } = req.params;
    const { window } = req.query;
    const regAddr = parseInt(regAddress);
    if (isNaN(regAddr)) {
      return res.status(400).json({ error: 'regAddress必须是数字' });
    }
    const result = await trendService.getCurveData(deviceId, regAddr, window);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result.points);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
