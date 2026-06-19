const express = require('express');
const router = express.Router();
const driftCalibrationService = require('../services/driftCalibrationService');

router.post('/configs', async (req, res) => {
  try {
    const result = await driftCalibrationService.createConfig(req.body);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.status(201).json(result.config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/configs', async (req, res) => {
  try {
    const { withStatus, deviceId } = req.query;
    let configs;
    if (withStatus === 'true' || withStatus === '1') {
      if (deviceId) {
        const all = await driftCalibrationService.getAllConfigsWithStatus();
        configs = all.filter(c => c.deviceId === deviceId);
      } else {
        configs = await driftCalibrationService.getAllConfigsWithStatus();
      }
    } else {
      if (deviceId) {
        configs = await driftCalibrationService.getConfigsByDevice(deviceId);
      } else {
        configs = await driftCalibrationService.getAllConfigs();
      }
    }
    res.json(configs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/configs/:id', async (req, res) => {
  try {
    const config = await driftCalibrationService.getConfigById(req.params.id);
    if (!config) {
      return res.status(404).json({ error: '配置不存在' });
    }
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/configs/:id', async (req, res) => {
  try {
    const result = await driftCalibrationService.updateConfig(req.params.id, req.body);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.json(result.config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/configs/:id', async (req, res) => {
  try {
    const result = await driftCalibrationService.deleteConfig(req.params.id);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/configs/:id/calibrate', async (req, res) => {
  try {
    const { compensateValue } = req.body;
    if (compensateValue === undefined) {
      return res.status(400).json({ error: '缺少compensateValue参数' });
    }
    const result = await driftCalibrationService.manualCalibrate(req.params.id, compensateValue);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.json({
      success: true,
      beforeMean: result.beforeMean,
      afterMean: result.afterMean,
      compensateValue: result.compensateValue,
      newBaseline: result.newBaseline,
      config: result.config
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/status/:deviceId/:regAddress', async (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const regAddress = parseInt(req.params.regAddress);
    const status = await driftCalibrationService.getConfigWithStatus(deviceId, regAddress);
    if (!status) {
      return res.status(404).json({ error: '该寄存器未配置漂移监控' });
    }
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/events', async (req, res) => {
  try {
    const { deviceId, startTime, endTime, activeOnly } = req.query;
    const events = await driftCalibrationService.getDriftEvents(
      deviceId || null,
      startTime ? parseInt(startTime) : null,
      endTime ? parseInt(endTime) : null,
      activeOnly === 'true' || activeOnly === '1'
    );
    res.json(events);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/calibrations', async (req, res) => {
  try {
    const { deviceId, startTime, endTime, status } = req.query;
    const history = await driftCalibrationService.getCalibrationHistory(
      deviceId || null,
      startTime ? parseInt(startTime) : null,
      endTime ? parseInt(endTime) : null,
      status || null
    );
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
