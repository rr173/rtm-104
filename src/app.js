const express = require('express');
const { init, all } = require('./db/database');
const deviceStore = require('./store/deviceStore');
const pollingStore = require('./store/pollingStore');
const deviceService = require('./services/deviceService');
const pollingService = require('./services/pollingService');
const computedTagService = require('./services/computedTagService');
const presetService = require('./services/presetService');
const alarmService = require('./services/alarmService');

const devicesRouter = require('./routes/devices');
const pollingRouter = require('./routes/polling');
const alarmsRouter = require('./routes/alarms');
const tagsRouter = require('./routes/tags');
const dataRouter = require('./routes/data');

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
      tags: '/api/tags',
      data: '/api/history and /api/snapshot'
    }
  });
});

app.use('/api/devices', devicesRouter);
app.use('/api/polling', pollingRouter);
app.use('/api/alarms', alarmsRouter);
app.use('/api/tags', tagsRouter);
app.use('/api', dataRouter);

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

async function restoreDevicesFromDB() {
  const devices = await all('SELECT id FROM devices');
  for (const d of devices) {
    const regs = await deviceService.getDeviceRegisters(d.id);
    deviceStore.addDevice(d.id, regs);
    pollingStore.initDevice(d.id);
  }
  console.log(`从数据库恢复 ${devices.length} 台设备`);
}

async function startup() {
  try {
    await init();
    console.log('数据库初始化完成');
    await restoreDevicesFromDB();
    await presetService.setupPresetData();
    await pollingService.startPollingForAll();
    await computedTagService.startAllComputedTags();
    await alarmService.evaluateAllAlarms();
    console.log('Modbus Gateway Service 启动完成');
    console.log(`预置数据: 温控器(high报警阈值80°C), 液位计(low报警阈值1m)`);
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
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  pollingStore.clearAllTimers();
  require('./store/computedTagStore').clearAllTimers();
  server.close(() => process.exit(0));
});

module.exports = app;
