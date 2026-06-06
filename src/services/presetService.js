const { get } = require('../db/database');
const deviceService = require('./deviceService');
const alarmService = require('./alarmService');
const pollingService = require('./pollingService');
const deviceStore = require('../store/deviceStore');

const PRESET_DEVICES = [
  {
    name: '温控器',
    slaveId: 1,
    registers: [
      { address: 0, name: '当前温度', dataType: 'float32', rw: 'RO', unit: '°C', description: '实时温度测量值' },
      { address: 2, name: '设定温度', dataType: 'float32', rw: 'RW', unit: '°C', description: '目标温度设定值' },
      { address: 4, name: '加热输出', dataType: 'uint16', rw: 'RO', unit: '%', description: '加热器输出占空比' },
      { address: 5, name: '运行状态', dataType: 'uint16', rw: 'RO', unit: '', description: '0=停机,1=运行,2=故障' }
    ],
    initialValues: {
      0: { type: 'float32', value: 25.5 },
      2: { type: 'float32', value: 60.0 },
      4: { type: 'uint16', value: 45 },
      5: { type: 'uint16', value: 1 }
    },
    polling: { intervalMs: 1000, priority: 2 }
  },
  {
    name: '变频器',
    slaveId: 2,
    registers: [
      { address: 0, name: '频率设定', dataType: 'float32', rw: 'RW', unit: 'Hz', description: '目标运行频率' },
      { address: 2, name: '实际频率', dataType: 'float32', rw: 'RO', unit: 'Hz', description: '当前输出频率' },
      { address: 4, name: '电流', dataType: 'float32', rw: 'RO', unit: 'A', description: '电机运行电流' }
    ],
    initialValues: {
      0: { type: 'float32', value: 50.0 },
      2: { type: 'float32', value: 49.8 },
      4: { type: 'float32', value: 12.5 }
    },
    polling: { intervalMs: 500, priority: 1 }
  },
  {
    name: '液位计',
    slaveId: 3,
    registers: [
      { address: 0, name: '液位', dataType: 'float32', rw: 'RO', unit: 'm', description: '当前液位高度' },
      { address: 2, name: '量程上限', dataType: 'uint16', rw: 'RO', unit: 'm', description: '传感器最大量程' }
    ],
    initialValues: {
      0: { type: 'float32', value: 3.2 },
      2: { type: 'uint16', value: 10 }
    },
    polling: { intervalMs: 2000, priority: 3 }
  }
];

async function setupPresetDevices() {
  const row = await get('SELECT COUNT(*) as cnt FROM devices');
  const count = row ? row.cnt : 0;
  if (count > 0) return null;

  const deviceIds = {};

  for (const preset of PRESET_DEVICES) {
    const result = await deviceService.createDevice({
      name: preset.name,
      slaveId: preset.slaveId,
      registers: preset.registers
    });

    if (!result.success) {
      console.error('创建设备失败:', preset.name, result.error);
      continue;
    }

    const devId = result.device.id;
    deviceIds[preset.name] = devId;

    for (const [addr, val] of Object.entries(preset.initialValues)) {
      deviceStore.setRegisterValue(devId, parseInt(addr), val.type, val.value);
    }

    await pollingService.setPollingConfig({
      deviceId: devId,
      intervalMs: preset.polling.intervalMs,
      priority: preset.polling.priority,
      enabled: true
    });
  }

  return deviceIds;
}

async function setupPresetAlarms(deviceIds) {
  const row = await get('SELECT COUNT(*) as cnt FROM alarm_rules');
  const count = row ? row.cnt : 0;
  if (count > 0) return;

  if (!deviceIds) {
    const devices = await deviceService.getAllDevices();
    deviceIds = {};
    for (const d of devices) {
      deviceIds[d.name] = d.id;
    }
  }

  if (deviceIds['温控器']) {
    await alarmService.createRule({
      deviceId: deviceIds['温控器'],
      regAddress: 0,
      alarmType: 'high',
      threshold: 80.0,
      hysteresis: 5.0,
      delaySeconds: 3
    });
  }

  if (deviceIds['液位计']) {
    await alarmService.createRule({
      deviceId: deviceIds['液位计'],
      regAddress: 0,
      alarmType: 'low',
      threshold: 1.0,
      hysteresis: 0.2,
      delaySeconds: 5
    });
  }
}

async function setupPresetData() {
  const deviceIds = await setupPresetDevices();
  await setupPresetAlarms(deviceIds);
}

module.exports = {
  setupPresetData
};
