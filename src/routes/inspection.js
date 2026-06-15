const express = require('express');
const router = express.Router();
const inspectionService = require('../services/inspectionService');

router.post('/templates', async (req, res) => {
  try {
    const result = await inspectionService.createTemplate(req.body);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.status(201).json(result.template);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/templates', async (req, res) => {
  try {
    const { period, deviceType } = req.query;
    const templates = await inspectionService.listTemplates({ period, deviceType });
    res.json(templates);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/templates/:id', async (req, res) => {
  try {
    const template = await inspectionService.getTemplateById(req.params.id);
    if (!template) {
      return res.status(404).json({ error: '模板不存在' });
    }
    res.json(template);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    const result = await inspectionService.deleteTemplate(req.params.id);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.json({ message: '模板已删除' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/tasks', async (req, res) => {
  try {
    const { status, deviceId, templateId, limit } = req.query;
    const tasks = await inspectionService.listTasks({ status, deviceId, templateId, limit });
    res.json(tasks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/tasks/:id', async (req, res) => {
  try {
    const task = await inspectionService.getTaskDetailById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: '巡检任务不存在' });
    }
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/tasks/:id/start', async (req, res) => {
  try {
    const result = await inspectionService.startTask(req.params.id);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.json(result.task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/tasks/:id/items/:itemId', async (req, res) => {
  try {
    const result = await inspectionService.fillResultItem(req.params.id, req.params.itemId, req.body);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.json(result.item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/tasks/:id/submit', async (req, res) => {
  try {
    const result = await inspectionService.submitTask(req.params.id);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.json(result.task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const { deviceId, startDate, endDate, limit } = req.query;
    const history = await inspectionService.getInspectionHistory({ deviceId, startDate, endDate, limit });
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/device/:deviceId/records', async (req, res) => {
  try {
    const records = await inspectionService.getDeviceInspectionRecords(req.params.deviceId);
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/device/:deviceId/pass-rate-trend', async (req, res) => {
  try {
    const trend = await inspectionService.getDevicePassRateTrend(req.params.deviceId);
    res.json(trend);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
