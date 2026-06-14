const express = require('express');
const router = express.Router();
const deviceService = require('../services/deviceService');
const maintenanceService = require('../services/maintenanceService');
const redundancyService = require('../services/redundancyService');

router.post('/', async (req, res) => {
  try {
    const result = await deviceService.createDevice(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.device);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const devices = await deviceService.getAllDevices();
    res.json(devices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const device = await deviceService.getDeviceDetail(req.params.id);
    if (!device) {
      return res.status(404).json({ error: '设备不存在' });
    }
    res.json(device);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const success = await deviceService.deleteDevice(req.params.id);
    if (!success) {
      return res.status(404).json({ error: '设备不存在' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/registers/write', async (req, res) => {
  try {
    const { address, value } = req.body;
    if (address === undefined || value === undefined) {
      return res.status(400).json({ error: '缺少address或value参数' });
    }

    const resolved = redundancyService.resolveDeviceForOperation(req.params.id);
    if (resolved.inDegraded) {
      return res.status(503).json({ error: `主备组[${resolved.groupName}]当前处于降级状态，没有可接管设备` });
    }
    const actualDeviceId = resolved.deviceId;

    if (maintenanceService.isDeviceLocked(actualDeviceId)) {
      return res.status(423).json({ error: '设备维保中' });
    }
    const result = await deviceService.writeRegister(actualDeviceId, address, value);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    try {
      const reg = await require('../db/database').get(
        'SELECT data_type FROM registers WHERE device_id = ? AND address = ?',
        [actualDeviceId, address]
      );
      if (reg) {
        await redundancyService.notifyRegisterWritten(actualDeviceId, address, reg.data_type, value);
      }
    } catch (syncErr) {
      console.error('[设备] 写寄存器后热同步备用机失败:', syncErr.message);
    }

    res.json({ ...result, deviceId: actualDeviceId, originalDeviceId: req.params.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/registers/batch-write', async (req, res) => {
  try {
    const { writes } = req.body;
    if (!Array.isArray(writes)) {
      return res.status(400).json({ error: 'writes必须是数组' });
    }

    const resolved = redundancyService.resolveDeviceForOperation(req.params.id);
    if (resolved.inDegraded) {
      return res.status(503).json({ error: `主备组[${resolved.groupName}]当前处于降级状态，没有可接管设备` });
    }
    const actualDeviceId = resolved.deviceId;

    if (maintenanceService.isDeviceLocked(actualDeviceId)) {
      return res.status(423).json({ error: '设备维保中' });
    }
    const result = await deviceService.writeMultipleRegisters(actualDeviceId, writes);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    try {
      const { get } = require('../db/database');
      for (const w of writes) {
        const reg = await get(
          'SELECT data_type FROM registers WHERE device_id = ? AND address = ?',
          [actualDeviceId, w.address]
        );
        if (reg) {
          await redundancyService.notifyRegisterWritten(actualDeviceId, w.address, reg.data_type, w.value);
        }
      }
    } catch (syncErr) {
      console.error('[设备] 批量写寄存器后热同步备用机失败:', syncErr.message);
    }

    res.json({ ...result, deviceId: actualDeviceId, originalDeviceId: req.params.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id/simulate-fault', (req, res) => {
  const { times } = req.body;
  if (times === undefined) {
    return res.status(400).json({ error: '缺少times参数' });
  }
  const result = deviceService.simulateFault(req.params.id, times);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

router.put('/:id/status', (req, res) => {
  const { status } = req.body;
  if (!status) {
    return res.status(400).json({ error: '缺少status参数' });
  }
  const result = deviceService.setDeviceStatus(req.params.id, status);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

router.post('/:id/registers/simulate', async (req, res) => {
  try {
    const { address, value } = req.body;
    if (address === undefined || value === undefined) {
      return res.status(400).json({ error: '缺少address或value参数' });
    }
    const result = await deviceService.simulateRegisterValue(req.params.id, address, value);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
