const { get, all } = require('../db/database');
const deviceService = require('./deviceService');
const alarmService = require('./alarmService');
const pollingService = require('./pollingService');
const interlockService = require('./interlockService');
const sequenceService = require('./sequenceService');
const recipeService = require('./recipeService');
const trendService = require('./trendService');
const firmwareService = require('./firmwareService');
const deviceStore = require('../store/deviceStore');
const energyService = require('./energyService');
const maintenanceService = require('./maintenanceService');

const PRESET_DEVICES = [
  {
    name: '温控器',
    slaveId: 1,
    registers: [
      { address: 0, name: '当前温度', dataType: 'float32', rw: 'RO', unit: '°C', description: '实时温度测量值' },
      { address: 2, name: '设定温度', dataType: 'float32', rw: 'RW', unit: '°C', description: '目标温度设定值' },
      { address: 4, name: '加热输出', dataType: 'uint16', rw: 'RO', unit: '%', description: '加热器输出占空比' },
      { address: 5, name: '运行状态', dataType: 'uint16', rw: 'RO', unit: '', description: '0=停机,1=运行,2=故障' },
      { address: 6, name: '有功功率', dataType: 'float32', rw: 'RO', unit: 'kW', description: '设备当前有功功率' }
    ],
    initialValues: {
      0: { type: 'float32', value: 25.5 },
      2: { type: 'float32', value: 60.0 },
      4: { type: 'uint16', value: 45 },
      5: { type: 'uint16', value: 1 },
      6: { type: 'float32', value: 7.5 }
    },
    polling: { intervalMs: 1000, priority: 2 }
  },
  {
    name: '变频器',
    slaveId: 2,
    registers: [
      { address: 0, name: '频率设定', dataType: 'float32', rw: 'RW', unit: 'Hz', description: '目标运行频率' },
      { address: 2, name: '实际频率', dataType: 'float32', rw: 'RO', unit: 'Hz', description: '当前输出频率' },
      { address: 4, name: '电流', dataType: 'float32', rw: 'RO', unit: 'A', description: '电机运行电流' },
      { address: 6, name: '有功功率', dataType: 'float32', rw: 'RO', unit: 'kW', description: '电机当前有功功率' }
    ],
    initialValues: {
      0: { type: 'float32', value: 50.0 },
      2: { type: 'float32', value: 49.8 },
      4: { type: 'float32', value: 12.5 },
      6: { type: 'float32', value: 15.2 }
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

async function setupPresetInterlocks(deviceIds) {
  const row = await get('SELECT COUNT(*) as cnt FROM interlocks');
  const count = row ? row.cnt : 0;
  if (count > 0) return;

  if (!deviceIds) {
    const devices = await deviceService.getAllDevices();
    deviceIds = {};
    for (const d of devices) {
      deviceIds[d.name] = d.id;
    }
  }

  if (deviceIds['液位计'] && deviceIds['变频器']) {
    await interlockService.createInterlock({
      name: '液位低停泵',
      condition: `${deviceIds['液位计']}.reg0 < 1.0`,
      actions: [
        { deviceId: deviceIds['变频器'], address: 0, value: 0 }
      ],
      priority: 5,
      enabled: true,
      autoReset: false
    });
    console.log('预置联锁: 液位低停泵');
  }

  if (deviceIds['温控器']) {
    await interlockService.createInterlock({
      name: '温度超限关加热',
      condition: `${deviceIds['温控器']}.reg0 > 90`,
      actions: [
        { deviceId: deviceIds['温控器'], address: 4, value: 0 }
      ],
      priority: 5,
      enabled: true,
      autoReset: false
    });
    console.log('预置联锁: 温度超限关加热');
  }
}

async function setupPresetSequences(deviceIds) {
  const row = await get('SELECT COUNT(*) as cnt FROM sequences');
  const count = row ? row.cnt : 0;
  if (count > 0) return;

  if (!deviceIds) {
    const devices = await deviceService.getAllDevices();
    deviceIds = {};
    for (const d of devices) {
      deviceIds[d.name] = d.id;
    }
  }

  if (deviceIds['变频器']) {
    await sequenceService.createSequence({
      name: '启动流程',
      steps: [
        {
          stepNumber: 1,
          actions: [
            { deviceId: deviceIds['变频器'], address: 0, value: 20 }
          ],
          transitionCondition: `${deviceIds['变频器']}.reg2 >= 18`,
          timeoutSeconds: 30,
          timeoutTarget: 'abort'
        },
        {
          stepNumber: 2,
          actions: [
            { deviceId: deviceIds['变频器'], address: 0, value: 50 }
          ],
          transitionCondition: `${deviceIds['变频器']}.reg2 >= 48`,
          timeoutSeconds: 30,
          timeoutTarget: 'abort'
        }
      ]
    });
    console.log('预置顺序程序: 启动流程');
  }
}

async function setupPresetRecipes(deviceIds) {
  const row = await get('SELECT COUNT(*) as cnt FROM recipes');
  const count = row ? row.cnt : 0;
  if (count > 0) return;

  if (!deviceIds) {
    const devices = await deviceService.getAllDevices();
    deviceIds = {};
    for (const d of devices) {
      deviceIds[d.name] = d.id;
    }
  }

  if (deviceIds['温控器'] && deviceIds['变频器']) {
    await recipeService.createRecipe({
      name: '产品A配方',
      description: '生产A产品时的参数设定：温控器60°C，变频器30Hz',
      items: [
        { deviceId: deviceIds['温控器'], address: 2, value: 60.0 },
        { deviceId: deviceIds['变频器'], address: 0, value: 30.0 }
      ]
    });
    console.log('预置配方: 产品A配方');

    await recipeService.createRecipe({
      name: '产品B配方',
      description: '生产B产品时的参数设定：温控器80°C，变频器50Hz',
      items: [
        { deviceId: deviceIds['温控器'], address: 2, value: 80.0 },
        { deviceId: deviceIds['变频器'], address: 0, value: 50.0 }
      ]
    });
    console.log('预置配方: 产品B配方');
  }
}

async function setupPresetTrends(deviceIds) {
  const row = await get('SELECT COUNT(*) as cnt FROM trend_configs');
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
    await trendService.createConfig({
      deviceId: deviceIds['温控器'],
      regAddress: 0,
      windowSize: 50,
      sensitivity: 3.0,
      intervalMs: 2000,
      enabled: true
    });
    console.log('预置趋势分析: 温控器-当前温度');
  }

  if (deviceIds['变频器']) {
    await trendService.createConfig({
      deviceId: deviceIds['变频器'],
      regAddress: 2,
      windowSize: 50,
      sensitivity: 3.0,
      intervalMs: 2000,
      enabled: true
    });
    console.log('预置趋势分析: 变频器-实际频率');
  }
}

const PRESET_FIRMWARE = [
  { version: '1.0.0', description: '初始稳定版本，基础功能完整' },
  { version: '1.1.0', description: '修复已知Bug，优化Modbus通讯稳定性' },
  { version: '2.0.0', description: '重大版本升级，新增OTA升级、趋势分析和配方管理功能' }
];

async function setupPresetFirmware() {
  const row = await get('SELECT COUNT(*) as cnt FROM firmware');
  const count = row ? row.cnt : 0;
  if (count > 0) return;

  for (const fw of PRESET_FIRMWARE) {
    const result = await firmwareService.uploadFirmware({
      version: fw.version,
      description: fw.description
    });
    if (result.success) {
      console.log(`预置固件版本: ${fw.version}`);
    } else {
      console.error('预置固件版本失败:', fw.version, result.error);
    }
  }
}

async function setupPresetEnergy(deviceIds) {
  const shiftRow = await get('SELECT COUNT(*) as cnt FROM work_shifts');
  const bindingRow = await get('SELECT COUNT(*) as cnt FROM energy_bindings');
  const shiftCount = shiftRow ? shiftRow.cnt : 0;
  const bindingCount = bindingRow ? bindingRow.cnt : 0;

  if (!deviceIds) {
    const devices = await deviceService.getAllDevices();
    deviceIds = {};
    for (const d of devices) {
      deviceIds[d.name] = d.id;
    }
  }

  const createdShifts = {};
  if (shiftCount === 0) {
    const threeShifts = [
      { name: '早班', startHour: 8, startMinute: 0, endHour: 16, endMinute: 0 },
      { name: '中班', startHour: 16, startMinute: 0, endHour: 0, endMinute: 0 },
      { name: '夜班', startHour: 0, startMinute: 0, endHour: 8, endMinute: 0 }
    ];
    for (const s of threeShifts) {
      const res = await energyService.createShift(s);
      if (res.success) {
        createdShifts[s.name] = res.shift.id;
        console.log(`预置班次: ${s.name}`);
      }
    }
  }

  if (bindingCount === 0) {
    if (deviceIds['温控器']) {
      const r1 = await energyService.createBinding({
        deviceId: deviceIds['温控器'],
        powerRegAddress: 6,
        ratedPower: 10.0,
        loadThreshold: 0.1,
        thresholdKwh: 80.0
      });
      if (r1.success) console.log('预置能耗绑定: 温控器-有功功率(reg6), 额定10kW, 阈值80kWh/班');
    }
    if (deviceIds['变频器']) {
      const r2 = await energyService.createBinding({
        deviceId: deviceIds['变频器'],
        powerRegAddress: 6,
        ratedPower: 18.5,
        loadThreshold: 0.1,
        thresholdKwh: 150.0
      });
      if (r2.success) console.log('预置能耗绑定: 变频器-有功功率(reg6), 额定18.5kW, 阈值150kWh/班');
    }
  }

  return createdShifts;
}

async function setupPresetMaintenance(deviceIds) {
  const row = await get('SELECT COUNT(*) as cnt FROM maintenance_orders');
  const count = row ? row.cnt : 0;
  if (count > 0) return;

  if (!deviceIds) {
    const devices = await deviceService.getAllDevices();
    deviceIds = {};
    for (const d of devices) {
      deviceIds[d.name] = d.id;
    }
  }

  const now = Date.now();

  if (deviceIds['温控器']) {
    const plannedResult = await maintenanceService.createOrder({
      deviceId: deviceIds['温控器'],
      maintenanceType: 'planned',
      plannedStartAt: now + 60 * 1000,
      plannedEndAt: now + 180 * 1000,
      description: '温控器季度例行检修计划',
      responsiblePerson: '张工'
    });
    if (plannedResult.success) {
      console.log('预置维保工单: 温控器计划维保(启动后60s开始,180s结束)');
    } else {
      console.error('预置温控器维保工单失败:', plannedResult.error);
    }
  }

  if (deviceIds['变频器']) {
    const emergencyResult = await maintenanceService.createOrder({
      deviceId: deviceIds['变频器'],
      maintenanceType: 'emergency',
      plannedEndAt: now + 120 * 1000,
      description: '变频器异常振动紧急检修',
      responsiblePerson: '李工'
    });
    if (emergencyResult.success) {
      console.log('预置维保工单: 变频器紧急维保(立即生效,持续120s)');
    } else {
      console.error('预置变频器维保工单失败:', emergencyResult.error);
    }
  }
}

async function setupPresetData() {
  await setupPresetFirmware();
  const deviceIds = await setupPresetDevices();
  await setupPresetAlarms(deviceIds);
  await setupPresetInterlocks(deviceIds);
  await setupPresetSequences(deviceIds);
  await setupPresetRecipes(deviceIds);
  await setupPresetTrends(deviceIds);
  await setupPresetEnergy(deviceIds);
  await setupPresetMaintenance(deviceIds);
}

module.exports = {
  setupPresetData
};
