const express = require('express');
const router = express.Router();
const computedTagService = require('../services/computedTagService');

router.post('/computed', async (req, res) => {
  try {
    const result = await computedTagService.createTag(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.tag);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/computed', (req, res) => {
  res.json(computedTagService.getAllTags());
});

router.get('/computed/:id', async (req, res) => {
  try {
    const tag = await computedTagService.getTagById(req.params.id);
    if (!tag) {
      return res.status(404).json({ error: '计算点位不存在' });
    }
    res.json(tag);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/computed/:id/history', async (req, res) => {
  try {
    const history = await computedTagService.getTagHistory(req.params.id, req.query.limit);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
