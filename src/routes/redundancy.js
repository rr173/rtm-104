const express = require('express');
const router = express.Router();
const redundancyService = require('../services/redundancyService');

router.post('/', async (req, res) => {
  try {
    const result = await redundancyService.createGroup(req.body);
    if (!result.success) {
      const code = result.code || 400;
      return res.status(code).json({ error: result.error });
    }
    res.status(201).json(result.group);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const groups = await redundancyService.getAllGroups();
    res.json(groups);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const history = await redundancyService.getSwitchHistory(null, req.query.limit);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/sync-logs', async (req, res) => {
  try {
    const logs = await redundancyService.getSyncLogs(null, req.query.limit);
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const group = await redundancyService.getGroupById(req.params.id);
    if (!group) {
      return res.status(404).json({ error: '主备组不存在' });
    }
    res.json(group);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const result = await redundancyService.updateGroup(req.params.id, req.body);
    if (!result.success) {
      const code = result.code || 400;
      return res.status(code).json({ error: result.error });
    }
    res.json(result.group);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const success = await redundancyService.deleteGroup(req.params.id);
    if (!success) {
      return res.status(404).json({ error: '主备组不存在' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/switch', async (req, res) => {
  try {
    const { targetDeviceId, operatorRemark } = req.body;
    if (!targetDeviceId) {
      return res.status(400).json({ error: '缺少 targetDeviceId' });
    }
    const result = await redundancyService.manualSwitch(
      req.params.id, targetDeviceId, operatorRemark
    );
    if (!result.success) {
      const code = result.code || 400;
      return res.status(code).json({
        error: result.error,
        degraded: result.degraded || false
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/history', async (req, res) => {
  try {
    const history = await redundancyService.getSwitchHistory(req.params.id, req.query.limit);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/sync-logs', async (req, res) => {
  try {
    const logs = await redundancyService.getSyncLogs(req.params.id, req.query.limit);
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/device/:deviceId/offline', async (req, res) => {
  try {
    const { offline, reason } = req.body;
    if (offline === undefined) {
      return res.status(400).json({ error: '缺少 offline 参数' });
    }
    const result = await redundancyService.setDeviceOffline(
      req.params.deviceId, !!offline, reason
    );
    if (!result.success) {
      const code = result.code || 400;
      return res.status(code).json({
        error: result.error,
        degraded: result.degraded || false
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
