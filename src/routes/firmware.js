const express = require('express');
const router = express.Router();
const firmwareService = require('../services/firmwareService');

router.post('/', async (req, res) => {
  try {
    const result = await firmwareService.uploadFirmware(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.firmware);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const firmwareList = await firmwareService.getAllFirmware();
    res.json(firmwareList);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const firmware = await firmwareService.getFirmwareById(req.params.id);
    if (!firmware) {
      return res.status(404).json({ error: '固件版本不存在' });
    }
    res.json(firmware);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/version/:version', async (req, res) => {
  try {
    const firmware = await firmwareService.getFirmwareByVersion(req.params.version);
    if (!firmware) {
      return res.status(404).json({ error: '固件版本不存在' });
    }
    res.json(firmware);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await firmwareService.deleteFirmware(req.params.id);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
