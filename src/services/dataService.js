const { all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const deviceService = require('./deviceService');
const computedTagService = require('./computedTagService');
const alarmService = require('./alarmService');

function parseIntervalMs(intervalStr) {
  if (!intervalStr) return null;
  const match = intervalStr.match(/^(\d+)(s|m|h)$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 3600 * 1000;
    default: return null;
  }
}

async function getRegisterHistory(deviceId, regAddress, startTime, endTime, intervalStr, limit) {
  let sql = `
    SELECT value, timestamp, stale
    FROM register_history
    WHERE device_id = ? AND reg_address = ?
  `;
  const params = [deviceId, regAddress];

  if (startTime) {
    sql += ' AND timestamp >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND timestamp <= ?';
    params.push(endTime);
  }
  sql += ' ORDER BY timestamp ASC';

  let rows = await all(sql, params);

  const intervalMs = parseIntervalMs(intervalStr);
  if (intervalMs && rows.length > 0) {
    const result = [];
    let bucketStart = rows[0].timestamp;
    let bucketSum = 0;
    let bucketCount = 0;

    for (const row of rows) {
      if (row.timestamp >= bucketStart + intervalMs) {
        if (bucketCount > 0) {
          result.push({
            value: bucketSum / bucketCount,
            timestamp: bucketStart,
            stale: 0
          });
        }
        while (row.timestamp >= bucketStart + intervalMs) {
          bucketStart += intervalMs;
        }
        bucketSum = 0;
        bucketCount = 0;
      }
      bucketSum += row.value;
      bucketCount++;
    }

    if (bucketCount > 0) {
      result.push({
        value: bucketSum / bucketCount,
        timestamp: bucketStart,
        stale: 0
      });
    }
    rows = result;
  }

  if (limit) {
    const lim = Math.min(parseInt(limit) || 1000, 10000);
    if (rows.length > lim) {
      rows = rows.slice(-lim);
    }
  }

  return rows;
}

async function getSnapshot() {
  const devices = await deviceService.getAllDevices();
  const devicesDetail = [];

  for (const d of devices) {
    const regs = await deviceService.getDeviceRegisters(d.id);
    const values = deviceStore.getAllRegisterValues(d.id, regs);
    devicesDetail.push({
      id: d.id,
      name: d.name,
      slaveId: d.slaveId,
      status: d.status,
      registers: values
    });
  }

  const computedTags = computedTagService.getAllTags();
  const activeAlarms = await alarmService.getActiveAlarms();

  return {
    timestamp: Date.now(),
    devices: devicesDetail,
    computedTags: computedTags.map(t => ({
      id: t.id,
      name: t.name,
      value: t.currentValue
    })),
    activeAlarmCount: activeAlarms.length
  };
}

module.exports = {
  getRegisterHistory,
  getSnapshot
};
