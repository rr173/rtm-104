const express = require('express');
const router = express.Router();
const alarmService = require('../services/alarmService');

router.post('/rules', async (req, res) => {
  try {
    const result = await alarmService.createRule(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.rule);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/rules/:id', async (req, res) => {
  try {
    const result = await alarmService.updateRule(req.params.id, req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result.rule);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/rules', async (req, res) => {
  try {
    res.json(await alarmService.getAllRules());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/active', async (req, res) => {
  try {
    res.json(await alarmService.getActiveAlarms());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const { deviceId, startTime, endTime } = req.query;
    const st = startTime ? parseInt(startTime) : null;
    const et = endTime ? parseInt(endTime) : null;
    res.json(await alarmService.getAlarmHistory(deviceId, st, et));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/acknowledge', async (req, res) => {
  try {
    const result = await alarmService.acknowledgeAlarm(req.params.id);
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
