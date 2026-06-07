const express = require('express');
const router = express.Router();
const energyService = require('../services/energyService');

router.post('/shifts', async (req, res) => {
  try {
    const result = await energyService.createShift(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.shift);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/shifts/:id', async (req, res) => {
  try {
    const result = await energyService.updateShift(req.params.id, req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result.shift);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/shifts/:id', async (req, res) => {
  try {
    const result = await energyService.deleteShift(req.params.id);
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/shifts', async (req, res) => {
  try {
    res.json(await energyService.getAllShifts());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/shifts/:id', async (req, res) => {
  try {
    const shift = await energyService.getShiftById(req.params.id);
    if (!shift) {
      return res.status(404).json({ error: '班次不存在' });
    }
    res.json(shift);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/bindings', async (req, res) => {
  try {
    const result = await energyService.createBinding(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.binding);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/bindings/:id', async (req, res) => {
  try {
    const result = await energyService.updateBinding(req.params.id, req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result.binding);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/bindings/:id', async (req, res) => {
  try {
    const result = await energyService.deleteBinding(req.params.id);
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/bindings', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (deviceId) {
      res.json(await energyService.getBindingsByDevice(deviceId));
    } else {
      res.json(await energyService.getAllBindings());
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/bindings/:id', async (req, res) => {
  try {
    const binding = await energyService.getBindingById(req.params.id);
    if (!binding) {
      return res.status(404).json({ error: '绑定不存在' });
    }
    res.json(binding);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const { deviceId, shiftId, shiftDate, startDate, endDate } = req.query;
    const query = {};
    if (deviceId) query.deviceId = deviceId;
    if (shiftId) query.shiftId = shiftId;
    if (shiftDate) query.shiftDate = shiftDate;
    if (startDate) query.startDate = startDate;
    if (endDate) query.endDate = endDate;
    res.json(await energyService.getShiftStats(query));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/compare', async (req, res) => {
  try {
    const { dateA, dateB, deviceId } = req.query;
    if (!dateA || !dateB) {
      return res.status(400).json({ error: '必须提供 dateA 和 dateB 参数' });
    }
    res.json(await energyService.compareTwoDates(dateA, dateB, deviceId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/alarms', async (req, res) => {
  try {
    const { deviceId, acknowledged, shiftDate } = req.query;
    const query = {};
    if (deviceId) query.deviceId = deviceId;
    if (acknowledged !== undefined) query.acknowledged = acknowledged === 'true' || acknowledged === '1';
    if (shiftDate) query.shiftDate = shiftDate;
    res.json(await energyService.getEnergyAlarms(query));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/alarms/:id/acknowledge', async (req, res) => {
  try {
    const result = await energyService.acknowledgeEnergyAlarm(req.params.id);
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }
    if (result.alreadyAcknowledged) {
      return res.status(409).json({ error: '该预警已被确认', alreadyAcknowledged: true });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/sample', async (req, res) => {
  try {
    await energyService.sampleAllEnergy();
    res.json({ success: true, message: '能耗采样已执行' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
