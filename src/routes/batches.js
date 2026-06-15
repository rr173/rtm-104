const express = require('express');
const router = express.Router();
const batchService = require('../services/batchService');

router.post('/', async (req, res) => {
  try {
    const result = await batchService.createBatch(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.batch);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const batches = await batchService.getAllBatches();
    res.json(batches);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const batch = await batchService.getBatchById(req.params.id);
    if (!batch) {
      return res.status(404).json({ error: '批次不存在' });
    }
    res.json(batch);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/start', async (req, res) => {
  try {
    const result = await batchService.startBatch(req.params.id);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ batch: result.batch });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/stop', async (req, res) => {
  try {
    const result = await batchService.stopBatch(req.params.id);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ batch: result.batch, report: result.report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/param-change', async (req, res) => {
  try {
    const result = await batchService.changeBatchParam(req.params.id, req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result.change);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/process-data', async (req, res) => {
  try {
    const result = await batchService.getBatchProcessData(req.params.id, req.query);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/param-changes', async (req, res) => {
  try {
    const changes = await batchService.getBatchParamChanges(req.params.id);
    res.json(changes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/report', async (req, res) => {
  try {
    const report = await batchService.getBatchReport(req.params.id);
    if (!report) {
      return res.status(404).json({ error: '批次报告不存在，批次可能尚未结束' });
    }
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/deviation-events', async (req, res) => {
  try {
    const result = await batchService.getDeviationEvents(req.params.id);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/deviation/current', async (req, res) => {
  try {
    const result = await batchService.getCurrentDeviationStatus();
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
