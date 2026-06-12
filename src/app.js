const express = require('express');
const { init, all } = require('./db/database');
const deviceStore = require('./store/deviceStore');
const pollingStore = require('./store/pollingStore');
const deviceService = require('./services/deviceService');
const pollingService = require('./services/pollingService');
const computedTagService = require('./services/computedTagService');
const presetService = require('./services/presetService');
const alarmService = require('./services/alarmService');
const notificationService = require('./services/notificationService');
const interlockService = require('./services/interlockService');
const sequenceService = require('./services/sequenceService');
const trendService = require('./services/trendService');
const firmwareService = require('./services/firmwareService');
const otaService = require('./services/otaService');
const energyService = require('./services/energyService');
const maintenanceService = require('./services/maintenanceService');

const devicesRouter = require('./routes/devices');
const pollingRouter = require('./routes/polling');
const alarmsRouter = require('./routes/alarms');
const notificationsRouter = require('./routes/notifications');
const tagsRouter = require('./routes/tags');
const dataRouter = require('./routes/data');
const interlocksRouter = require('./routes/interlocks');
const sequencesRouter = require('./routes/sequences');
const recipesRouter = require('./routes/recipes');
const trendsRouter = require('./routes/trends');
const replayRouter = require('./routes/replay');
const firmwareRouter = require('./routes/firmware');
const otaRouter = require('./routes/ota');
const energyRouter = require('./routes/energy');
const maintenanceRouter = require('./routes/maintenance');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

app.get('/', (req, res) => {
  res.json({
    name: 'Modbus Gateway Service',
    version: '1.0.0',
    endpoints: {
      devices: '/api/devices',
      polling: '/api/polling',
      alarms: '/api/alarms',
      notifications: '/api/notifications',
      tags: '/api/tags',
      data: '/api/history and /api/snapshot',
      interlocks: '/api/interlocks',
      sequences: '/api/sequences',
      recipes: '/api/recipes',
      trends: '/api/trends',
      replay: '/api/replay',
      compare: '/api/compare',
      firmware: '/api/firmware',
      ota: '/api/ota',
      energy: '/api/energy',
      maintenance: '/api/maintenance'
    }
  });
});

app.use('/api/devices', devicesRouter);
app.use('/api/polling', pollingRouter);
app.use('/api/alarms', alarmsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/tags', tagsRouter);
app.use('/api', dataRouter);
app.use('/api/interlocks', interlocksRouter);
app.use('/api/sequences', sequencesRouter);
app.use('/api/recipes', recipesRouter);
app.use('/api/trends', trendsRouter);
app.use('/api/replay', replayRouter);
app.use('/api/firmware', firmwareRouter);
app.use('/api/ota', otaRouter);
app.use('/api/energy', energyRouter);
app.use('/api/maintenance', maintenanceRouter);

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

async function restoreDevicesFromDB() {
  const devices = await all('SELECT id, firmware_version FROM devices');
  for (const d of devices) {
    const regs = await deviceService.getDeviceRegisters(d.id);
    deviceStore.addDevice(d.id, regs, d.firmware_version || '1.0.0');
    pollingStore.initDevice(d.id);
  }
  console.log(`从数据库恢复 ${devices.length} 台设备`);
}

async function startup() {
  try {
    await init();
    console.log('数据库初始化完成');
    await restoreDevicesFromDB();
    const fwCount = await firmwareService.loadFirmwareFromDB();
    console.log(`从数据库加载 ${fwCount} 个固件版本`);
    const otaCount = await otaService.loadOtaHistoryFromDB();
    console.log(`从数据库加载 ${otaCount} 条OTA升级历史`);
    const maintCount = await maintenanceService.loadOrdersFromDB();
    console.log(`从数据库恢复 ${maintCount} 个进行中的维保工单锁定状态`);
    await presetService.setupPresetData();
    await pollingService.startPollingForAll();
    await computedTagService.startAllComputedTags();
    await alarmService.evaluateAllAlarms();
    interlockService.startEngine();
    sequenceService.startEngine();
    notificationService.startEngine();
    await trendService.startEngineForAll();
    energyService.startEngine();
    maintenanceService.startEngine();
    console.log('Modbus Gateway Service 启动完成');
    console.log(`预置数据: 温控器(high报警阈值80°C), 液位计(low报警阈值1m)`);
    console.log(`预置联锁: 液位低停泵、温度超限关加热`);
    console.log(`预置顺序程序: 启动流程`);
    console.log(`预置配方: 产品A配方(温控60°C/变频30Hz)、产品B配方(温控80°C/变频50Hz)`);
    console.log(`预置趋势分析: 温控器当前温度(窗口50/3-sigma/2s)、变频器实际频率(窗口50/3-sigma/2s)`);
    console.log(`预置固件版本: 1.0.0/1.1.0/2.0.0, 设备初始版本1.0.0`);
    console.log(`预置维保工单: 温控器计划维保(60s后开始,180s后结束)、变频器紧急维保(立即开始,120s后结束)`);
  } catch (e) {
    console.error('启动失败:', e);
    process.exit(1);
  }
}

const server = app.listen(PORT, () => {
  console.log(`Modbus Gateway Service 运行于 http://localhost:${PORT}`);
  startup();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  pollingStore.clearAllTimers();
  require('./store/computedTagStore').clearAllTimers();
  require('./store/otaStore').clearAllTimers();
  require('./store/maintenanceStore').clearAllTimers();
  interlockService.stopEngine();
  sequenceService.stopEngine();
  notificationService.stopEngine();
  trendService.stopEngine();
  energyService.stopEngine();
  maintenanceService.stopEngine();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  pollingStore.clearAllTimers();
  require('./store/computedTagStore').clearAllTimers();
  require('./store/otaStore').clearAllTimers();
  require('./store/maintenanceStore').clearAllTimers();
  interlockService.stopEngine();
  sequenceService.stopEngine();
  notificationService.stopEngine();
  trendService.stopEngine();
  energyService.stopEngine();
  maintenanceService.stopEngine();
  server.close(() => process.exit(0));
});

module.exports = app;
