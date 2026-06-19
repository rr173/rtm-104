const express = require('express');
const router = express.Router();
const modeService = require('../services/modeService');

router.post('/', async (req, res) => {
  try {
    const result = await modeService.createMode(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.mode);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) {
      return res.status(400).json({ error: '缺少deviceId查询参数' });
    }
    const modes = await modeService.getModesByDevice(deviceId);
    res.json(modes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/switch', async (req, res) => {
  try {
    const { deviceId, modeId, operator } = req.body;
    if (!deviceId || !modeId) {
      return res.status(400).json({ error: '缺少deviceId或modeId' });
    }
    const result = await modeService.switchMode(deviceId, modeId, operator);
    if (!result.success) {
      const code = result.rolledBack ? 500 : 400;
      return res.status(code).json({ error: result.error, rolledBack: result.rolledBack });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/exit', async (req, res) => {
  try {
    const { deviceId, operator } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: '缺少deviceId' });
    }
    const result = await modeService.exitMode(deviceId, operator);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/active/:deviceId', async (req, res) => {
  try {
    const activeMode = modeService.getActiveMode(req.params.deviceId);
    if (!activeMode) {
      return res.json({ activeMode: null });
    }
    res.json({ activeMode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const { deviceId, limit } = req.query;
    const history = await modeService.getModeHistory(deviceId, limit);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const mode = await modeService.getModeById(req.params.id);
    if (!mode) {
      return res.status(404).json({ error: '模式不存在' });
    }
    res.json(mode);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await modeService.deleteMode(req.params.id);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
