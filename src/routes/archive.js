const express = require('express');
const router = express.Router();
const archiveService = require('../services/archiveService');
const deviceService = require('../services/deviceService');

router.get('/policies', async (req, res) => {
  try {
    const policies = await archiveService.getAllPolicies();
    res.json(policies);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/policies/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const policy = await archiveService.getPolicy(deviceId);
    res.json(policy);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/policies/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { retentionDays, granularity, enabled } = req.body;

    const device = await deviceService.getDeviceById(deviceId);
    if (!device) {
      return res.status(404).json({ error: '设备不存在' });
    }

    let granularitySeconds = null;
    if (granularity !== undefined) {
      granularitySeconds = archiveService.parseGranularity(granularity);
      if (granularitySeconds === null) {
        return res.status(400).json({ error: '归档粒度格式错误，例如：1m、5m、1h' });
      }
    }

    const result = await archiveService.setPolicy(deviceId, {
      retentionDays,
      granularitySeconds,
      enabled
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result.policy);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/policies/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const deleted = await archiveService.deletePolicy(deviceId);
    if (!deleted) {
      return res.status(404).json({ error: '策略不存在' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/run', async (req, res) => {
  try {
    const { customRetentionDays } = req.body;
    
    if (customRetentionDays !== undefined && customRetentionDays < 1) {
      return res.status(400).json({ error: '保留天数必须大于0' });
    }

    const result = await archiveService.runArchive({
      triggeredBy: 'manual',
      customRetentionDays
    });

    if (!result.success) {
      return res.status(409).json({ error: result.error });
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/runs', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 20;
    const runs = await archiveService.getArchiveRuns(limit);
    res.json(runs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const stats = await archiveService.getDataStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const status = archiveService.getStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
