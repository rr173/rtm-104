const express = require('express');
const router = express.Router();
const dataService = require('../services/dataService');
const compareService = require('../services/compareService');

router.get('/history/:deviceId/:regAddress', async (req, res) => {
  try {
    const { deviceId, regAddress } = req.params;
    const { startTime, endTime, interval, limit } = req.query;

    const st = startTime ? parseInt(startTime) : null;
    const et = endTime ? parseInt(endTime) : null;
    const regAddr = parseInt(regAddress);

    if (isNaN(regAddr)) {
      return res.status(400).json({ error: 'regAddress必须是数字' });
    }

    const history = await dataService.getRegisterHistory(deviceId, regAddr, st, et, interval, limit);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/snapshot', async (req, res) => {
  try {
    res.json(await dataService.getSnapshot());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/compare', async (req, res) => {
  try {
    const result = await compareService.compare(req.body);
    if (!result.success) {
      const statusCode = result.code || 400;
      return res.status(statusCode).json({ error: result.error });
    }
    res.json({
      periodA: result.periodA,
      periodB: result.periodB,
      diff: result.diff
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
