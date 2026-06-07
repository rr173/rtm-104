const express = require('express');
const router = express.Router();
const otaService = require('../services/otaService');

router.post('/start', async (req, res) => {
  try {
    const { deviceId, firmwareId } = req.body;
    if (!deviceId || !firmwareId) {
      return res.status(400).json({ error: '缺少deviceId或firmwareId参数' });
    }
    const result = await otaService.startUpgrade(deviceId, firmwareId);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.upgrade);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/progress/:deviceId', (req, res) => {
  try {
    const progress = otaService.getUpgradeProgress(req.params.deviceId);
    if (!progress) {
      return res.status(404).json({ error: '该设备没有正在进行的升级任务' });
    }
    res.json(progress);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const { deviceId, limit } = req.query;
    const parsedLimit = limit ? parseInt(limit) : 50;
    const history = await otaService.getUpgradeHistory(deviceId || null, parsedLimit);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stages', (req, res) => {
  try {
    const stages = otaService.STAGES.map(s => ({
      name: s.name,
      label: s.label,
      duration: s.duration,
      progressStart: s.progressStart,
      progressEnd: s.progressEnd
    }));
    res.json(stages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history/:deviceId', async (req, res) => {
  try {
    const { limit } = req.query;
    const parsedLimit = limit ? parseInt(limit) : 50;
    const history = await otaService.getUpgradeHistory(req.params.deviceId, parsedLimit);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:upgradeId', async (req, res) => {
  try {
    const upgrade = await otaService.getUpgradeById(req.params.upgradeId);
    if (!upgrade) {
      return res.status(404).json({ error: '升级任务不存在' });
    }
    res.json(upgrade);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
