const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const pollingStore = require('../store/pollingStore');
const deviceService = require('./deviceService');
const otaService = require('./otaService');
const maintenanceService = require('./maintenanceService');
const redundancyService = require('./redundancyService');
const { getRegisterSpan } = require('../utils/modbus');

function validateConfig(body) {
  if (!body.deviceId) {
    return '缺少deviceId';
  }
  if (typeof body.intervalMs !== 'number' || body.intervalMs < 100 || body.intervalMs > 60000) {
    return '轮询周期必须在100-60000ms之间';
  }
  if (typeof body.priority !== 'number' || body.priority < 1 || body.priority > 5) {
    return '优先级必须在1-5之间';
  }
  if (!deviceStore.hasDevice(body.deviceId)) {
    return '设备不存在';
  }
  return null;
}

function collectRegisterAddresses(deviceId, registers) {
  const addresses = new Set();
  for (const r of registers) {
    const span = getRegisterSpan(r.data_type);
    for (let i = 0; i < span; i++) {
      addresses.add(r.address + i);
    }
  }
  return [...addresses];
}

async function doPoll(deviceId) {
  pollingStore.initDevice(deviceId);

  const registers = await deviceService.getDeviceRegisters(deviceId);
  const addrs = collectRegisterAddresses(deviceId, registers);

  const isUnderMaintenance = maintenanceService.isDeviceLocked(deviceId);

  if (deviceStore.consumeFault(deviceId)) {
    pollingStore.recordFailure(deviceId);
    const st = pollingStore.getStatus(deviceId);
    if (st.consecutiveFailures >= 3) {
      deviceStore.setStatus(deviceId, 'offline');
      try {
        await redundancyService.checkAndSwitchForDevice(
          deviceId,
          redundancyService.SWITCH_REASONS.POLLING_FAILURE,
          `连续${st.consecutiveFailures}次轮询失败`
        );
      } catch (e) {
        console.error('[冗余] 轮询失败触发切换出错:', e.message);
      }
    }

    deviceStore.markStale(deviceId, addrs);

    const now = Date.now();
    for (const r of registers) {
      const { value } = deviceStore.getRegisterValue(deviceId, r.address, r.data_type);
      await run(`INSERT INTO register_history (device_id, reg_address, value, timestamp, stale)
        VALUES (?, ?, ?, ?, 1)`, [deviceId, r.address, value, now]);
    }
    return;
  }

  deviceStore.clearStale(deviceId);

  const now = Date.now();
  for (const r of registers) {
    const { value } = deviceStore.getRegisterValue(deviceId, r.address, r.data_type);
    await run(`INSERT INTO register_history (device_id, reg_address, value, timestamp, stale)
      VALUES (?, ?, ?, ?, ?)`, [deviceId, r.address, value, now, isUnderMaintenance ? 2 : 0]);
  }

  pollingStore.recordSuccess(deviceId);
  if (!isUnderMaintenance) {
    deviceStore.setStatus(deviceId, 'online');
  }

  try {
    await redundancyService.checkDeviceRecovery(deviceId);
  } catch (e) {
    console.error('[冗余] 设备恢复检查出错:', e.message);
  }

  if (!isUnderMaintenance) {
    try {
      const { evaluateAlarmsForDevice } = require('./alarmService');
      await evaluateAlarmsForDevice(deviceId);
    } catch (e) {
      console.error('Alarm eval error:', e.message);
    }
  }
}

async function setPollingConfig(body) {
  const err = validateConfig(body);
  if (err) {
    return { success: false, error: err };
  }

  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1;

  await run(`INSERT INTO polling_config (device_id, interval_ms, priority, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      interval_ms = excluded.interval_ms,
      priority = excluded.priority,
      enabled = excluded.enabled`,
    [body.deviceId, body.intervalMs, body.priority, enabled]);

  pollingStore.clearTimer(body.deviceId);
  pollingStore.initDevice(body.deviceId);

  if (enabled && !otaService.isDeviceUpgrading(body.deviceId)) {
    const timer = setInterval(async () => {
      try {
        if (!otaService.isDeviceUpgrading(body.deviceId)) {
          await doPoll(body.deviceId);
        }
      } catch (e) {
        console.error('Poll error:', e);
      }
    }, body.intervalMs);
    timer.unref();
    pollingStore.setTimer(body.deviceId, timer);

    setTimeout(async () => {
      try {
        if (!otaService.isDeviceUpgrading(body.deviceId)) {
          await doPoll(body.deviceId);
        }
      } catch (e) {}
    }, 100);
  }

  return { success: true, config: await getConfig(body.deviceId) };
}

async function getConfig(deviceId) {
  const row = await get('SELECT * FROM polling_config WHERE device_id = ?', [deviceId]);
  if (!row) return null;
  return {
    deviceId: row.device_id,
    intervalMs: row.interval_ms,
    priority: row.priority,
    enabled: !!row.enabled
  };
}

async function getAllConfigs() {
  const rows = await all('SELECT * FROM polling_config');
  return rows.map(row => ({
    deviceId: row.device_id,
    intervalMs: row.interval_ms,
    priority: row.priority,
    enabled: !!row.enabled
  }));
}

function getAllStatus() {
  return pollingStore.getAllStatus();
}

async function startPollingForAll() {
  const configs = await getAllConfigs();
  for (const c of configs) {
    if (c.enabled) {
      await setPollingConfig(c);
    }
  }
}

module.exports = {
  setPollingConfig,
  getConfig,
  getAllConfigs,
  getAllStatus,
  doPoll,
  startPollingForAll,
  collectRegisterAddresses
};
