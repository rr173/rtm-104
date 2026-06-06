const express = require('express');
const router = express.Router();
const sequenceService = require('../services/sequenceService');

router.post('/', async (req, res) => {
  try {
    const result = await sequenceService.createSequence(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.sequence);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const sequences = await sequenceService.getAllSequences();
    res.json(sequences);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const seq = await sequenceService.getSequenceById(req.params.id);
    if (!seq) {
      return res.status(404).json({ error: '顺序程序不存在' });
    }
    res.json(seq);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const success = await sequenceService.deleteSequence(req.params.id);
    if (!success) {
      return res.status(404).json({ error: '顺序程序不存在' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/status', async (req, res) => {
  try {
    const seq = await sequenceService.getSequenceById(req.params.id);
    if (!seq) {
      return res.status(404).json({ error: '顺序程序不存在' });
    }
    const status = sequenceService.getSequenceStatus(req.params.id);
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/start', async (req, res) => {
  try {
    const result = await sequenceService.startSequence(req.params.id);
    if (!result.success) {
      const code = result.code || 400;
      return res.status(code).json({ error: result.error });
    }
    res.json(result.status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/stop', async (req, res) => {
  try {
    const result = sequenceService.stopSequence(req.params.id);
    if (!result.success) {
      const code = result.code || 400;
      return res.status(code).json({ error: result.error });
    }
    res.json(result.status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
