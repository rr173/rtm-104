const { all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const deviceService = require('./deviceService');
const computedTagService = require('./computedTagService');
const alarmService = require('./alarmService');
const archiveService = require('./archiveService');

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
  return await archiveService.getRegisterHistoryWithArchive(
    deviceId, regAddress, startTime, endTime, intervalStr, limit
  );
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
