const express = require('express');
const router = express.Router();
const interlockService = require('../services/interlockService');

router.post('/', async (req, res) => {
  try {
    const result = await interlockService.createInterlock(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.interlock);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const interlocks = await interlockService.getAllInterlocks();
    res.json(interlocks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/events', async (req, res) => {
  try {
    const limit = req.query.limit;
    const events = await interlockService.getEvents(limit);
    res.json(events);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const il = await interlockService.getInterlockById(req.params.id);
    if (!il) {
      return res.status(404).json({ error: '联锁规则不存在' });
    }
    res.json(il);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const result = await interlockService.updateInterlock(req.params.id, req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result.interlock);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const success = await interlockService.deleteInterlock(req.params.id);
    if (!success) {
      return res.status(404).json({ error: '联锁规则不存在' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/reset', async (req, res) => {
  try {
    const result = await interlockService.resetInterlock(req.params.id);
    if (!result.success) {
      const code = result.code || 400;
      return res.status(code).json({
        error: result.error,
        currentTriggerValue: result.currentTriggerValue
      });
    }
    res.json({ success: true, message: result.message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
