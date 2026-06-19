const express = require('express');
const router = express.Router();
const shiftDutyService = require('../services/shiftDutyService');

router.post('/shifts', async (req, res) => {
  try {
    const result = await shiftDutyService.createShift(req.body);
    if (!result.success) return res.status(result.code || 400).json({ error: result.error });
    res.status(201).json(result.shift);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/shifts', async (req, res) => {
  try {
    res.json(await shiftDutyService.getAllShifts());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/shifts/current', async (req, res) => {
  try {
    const shift = await shiftDutyService.getCurrentShift();
    if (!shift) return res.status(404).json({ error: '当前时间没有匹配的班次' });
    res.json(shift);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/shifts/:id', async (req, res) => {
  try {
    const shift = await shiftDutyService.getShiftById(req.params.id);
    if (!shift) return res.status(404).json({ error: '班次不存在' });
    res.json(shift);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/shifts/:id', async (req, res) => {
  try {
    const result = await shiftDutyService.updateShift(req.params.id, req.body);
    if (!result.success) return res.status(result.code || 400).json({ error: result.error });
    res.json(result.shift);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/shifts/:id', async (req, res) => {
  try {
    const result = await shiftDutyService.deleteShift(req.params.id);
    if (!result.success) return res.status(result.code || 400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/current-log', async (req, res) => {
  try {
    const log = await shiftDutyService.getCurrentLogWithEntries();
    if (!log) return res.status(404).json({ error: '没有当前活跃的值班日志' });
    res.json(log);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/entries', async (req, res) => {
  try {
    const result = await shiftDutyService.addManualEntry(req.body);
    if (!result.success) return res.status(result.code || 400).json({ error: result.error });
    res.status(201).json(result.entry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/handover/initiate', async (req, res) => {
  try {
    const result = await shiftDutyService.initiateHandover(req.body);
    if (!result.success) return res.status(result.code || 400).json({ error: result.error });
    res.status(201).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/handover/pending', async (req, res) => {
  try {
    const handover = await shiftDutyService.getPendingHandover();
    if (!handover) return res.status(404).json({ error: '没有待签收的交接记录' });
    res.json(handover);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/handover/:id/confirm', async (req, res) => {
  try {
    const result = await shiftDutyService.confirmHandover(req.params.id);
    if (!result.success) return res.status(result.code || 400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/handover/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await shiftDutyService.rejectHandover(req.params.id, reason);
    if (!result.success) return res.status(result.code || 400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/logs/:id', async (req, res) => {
  try {
    const log = await shiftDutyService.getLogById(req.params.id);
    if (!log) return res.status(404).json({ error: '值班日志不存在' });
    res.json(log);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/logs', async (req, res) => {
  try {
    const logs = await shiftDutyService.queryLogs(req.query);
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/statistics', async (req, res) => {
  try {
    const stats = await shiftDutyService.getStatistics(req.query);
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
