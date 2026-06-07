const { all, run } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const pollingStore = require('../store/pollingStore');
const pollingService = require('./pollingService');
const alarmService = require('./alarmService');
const deviceService = require('./deviceService');

const VALID_SPEEDS = [1, 2, 5, 10, 20];

let replayState = {
  isRunning: false,
  timer: null,
  deviceIds: [],
  startTime: 0,
  endTime: 0,
  speedMultiplier: 1,
  startedAt: 0,
  records: [],
  currentIndex: 0,
  currentReplayTime: 0,
  pollingConfigs: [],
  registerCache: new Map()
};

async function getHistoryRecords(deviceIds, startTime, endTime) {
  const placeholders = deviceIds.map(() => '?').join(',');
  const rows = await all(
    `SELECT device_id, reg_address, value, timestamp 
     FROM register_history 
     WHERE device_id IN (${placeholders}) 
       AND timestamp >= ? 
       AND timestamp <= ? 
     ORDER BY timestamp ASC`,
    [...deviceIds, startTime, endTime]
  );
  return rows;
}

async function getCurrentAlarmCount() {
  const rows = await all('SELECT COUNT(*) as cnt FROM alarms WHERE triggered_at >= ?', [replayState.startedAt]);
  return rows[0] ? rows[0].cnt : 0;
}

async function getCurrentInterlockCount() {
  const rows = await all('SELECT COUNT(*) as cnt FROM interlock_events WHERE timestamp >= ?', [replayState.startedAt]);
  return rows[0] ? rows[0].cnt : 0;
}

async function collectTriggeredAlarms() {
  const rows = await all(
    `SELECT a.*, d.name as device_name, r.name as reg_name
     FROM alarms a
     JOIN devices d ON a.device_id = d.id
     LEFT JOIN registers r ON a.device_id = r.device_id AND a.reg_address = r.address
     WHERE a.triggered_at >= ?
     ORDER BY a.triggered_at ASC`,
    [replayState.startedAt]
  );
  return rows.map(row => ({
    id: row.id,
    ruleId: row.rule_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    regAddress: row.reg_address,
    regName: row.reg_name,
    alarmType: row.alarm_type,
    threshold: row.threshold,
    currentValue: row.current_value,
    triggeredAt: row.triggered_at,
    recoveredAt: row.recovered_at
  }));
}

async function collectTriggeredInterlocks() {
  const rows = await all(
    `SELECT * FROM interlock_events WHERE timestamp >= ? ORDER BY timestamp ASC`,
    [replayState.startedAt]
  );
  return rows.map(row => ({
    id: row.id,
    interlockId: row.interlock_id,
    interlockName: row.interlock_name,
    triggerValue: row.trigger_value,
    actions: JSON.parse(row.actions),
    timestamp: row.timestamp
  }));
}

async function saveReport() {
  const alarms = await collectTriggeredAlarms();
  const interlocks = await collectTriggeredInterlocks();

  await run(
    `INSERT INTO replay_reports 
     (device_ids, start_time, end_time, speed_multiplier, started_at, finished_at, 
      total_records, triggered_alarms, triggered_interlocks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      JSON.stringify(replayState.deviceIds),
      replayState.startTime,
      replayState.endTime,
      replayState.speedMultiplier,
      replayState.startedAt,
      Date.now(),
      replayState.records.length,
      JSON.stringify(alarms),
      JSON.stringify(interlocks)
    ]
  );

  return { alarms, interlocks };
}

function stopPolling() {
  const configs = pollingService.getAllConfigs();
  replayState.pollingConfigs = configs.filter(c => c.enabled);
  pollingStore.clearAllTimers();
}

async function restorePolling() {
  for (const c of replayState.pollingConfigs) {
    await pollingService.setPollingConfig(c);
  }
  replayState.pollingConfigs = [];
}

async function cacheRegisters(deviceIds) {
  replayState.registerCache = new Map();
  for (const deviceId of deviceIds) {
    const regs = await deviceService.getDeviceRegisters(deviceId);
    const addrMap = new Map();
    for (const reg of regs) {
      addrMap.set(reg.address, reg.data_type);
    }
    replayState.registerCache.set(deviceId, addrMap);
  }
}

function getRegisterDataType(deviceId, address) {
  const deviceMap = replayState.registerCache.get(deviceId);
  if (!deviceMap) return 'float32';
  return deviceMap.get(address) || 'float32';
}

function validateStartRequest(body) {
  if (!Array.isArray(body.deviceIds) || body.deviceIds.length === 0) {
    return 'deviceIds必须是非空数组';
  }
  for (const id of body.deviceIds) {
    if (!deviceStore.hasDevice(id)) {
      return `设备不存在: ${id}`;
    }
  }
  if (typeof body.startTime !== 'number' || typeof body.endTime !== 'number') {
    return 'startTime和endTime必须是数字时间戳';
  }
  if (body.startTime >= body.endTime) {
    return 'startTime必须小于endTime';
  }
  if (!VALID_SPEEDS.includes(body.speedMultiplier)) {
    return 'speedMultiplier必须是 1/2/5/10/20 之一';
  }
  return null;
}

async function startReplay(body) {
  if (replayState.isRunning) {
    return { success: false, error: '已有回放任务在运行中', code: 409 };
  }

  const err = validateStartRequest(body);
  if (err) {
    return { success: false, error: err, code: 400 };
  }

  const records = await getHistoryRecords(body.deviceIds, body.startTime, body.endTime);
  if (records.length === 0) {
    return { success: false, error: '该时间段内没有历史数据', code: 400 };
  }

  await cacheRegisters(body.deviceIds);

  stopPolling();

  replayState.isRunning = true;
  replayState.timer = null;
  replayState.deviceIds = body.deviceIds;
  replayState.startTime = body.startTime;
  replayState.endTime = body.endTime;
  replayState.speedMultiplier = body.speedMultiplier;
  replayState.startedAt = Date.now();
  replayState.records = records;
  replayState.currentIndex = 0;
  replayState.currentReplayTime = records[0].timestamp;

  async function processNext() {
    if (!replayState.isRunning) return;

    if (replayState.currentIndex >= replayState.records.length) {
      await finishReplay();
      return;
    }

    const record = replayState.records[replayState.currentIndex];
    const nextRecord = replayState.records[replayState.currentIndex + 1];

    const dataType = getRegisterDataType(record.device_id, record.reg_address);
    deviceStore.setRegisterValue(record.device_id, record.reg_address, dataType, record.value);

    try {
      await alarmService.evaluateAlarmsForDevice(record.device_id);
    } catch (e) {
      console.error('回放期间报警评估错误:', e.message);
    }

    replayState.currentReplayTime = record.timestamp;
    replayState.currentIndex++;

    if (nextRecord) {
      const realInterval = nextRecord.timestamp - record.timestamp;
      const replayInterval = Math.max(1, Math.floor(realInterval / replayState.speedMultiplier));
      replayState.timer = setTimeout(processNext, replayInterval);
    } else {
      await finishReplay();
    }
  }

  processNext().catch(e => {
    console.error('回放错误:', e);
    stopReplayInternal().catch(() => {});
  });

  return { success: true, status: await getStatus() };
}

async function finishReplay() {
  if (!replayState.isRunning) return;
  replayState.isRunning = false;
  if (replayState.timer) {
    clearTimeout(replayState.timer);
    replayState.timer = null;
  }
  const report = await saveReport();
  await restorePolling();
  console.log(`回放完成，共处理 ${replayState.records.length} 条记录，触发 ${report.alarms.length} 个报警，${report.interlocks.length} 个联锁`);
}

async function stopReplayInternal() {
  if (!replayState.isRunning) return;
  replayState.isRunning = false;
  if (replayState.timer) {
    clearTimeout(replayState.timer);
    replayState.timer = null;
  }
  await saveReport();
  await restorePolling();
}

async function stopReplay() {
  if (!replayState.isRunning) {
    return { success: false, error: '当前没有回放任务在运行', code: 400 };
  }
  await stopReplayInternal();
  return { success: true, status: await getStatus() };
}

async function getStatus() {
  const total = replayState.records.length;
  const progress = total > 0 ? Math.floor((replayState.currentIndex / total) * 100) : 0;

  let triggeredAlarmCount = 0;
  let triggeredInterlockCount = 0;
  if (replayState.isRunning) {
    try {
      triggeredAlarmCount = await getCurrentAlarmCount();
      triggeredInterlockCount = await getCurrentInterlockCount();
    } catch (e) {
      console.error('获取回放状态计数错误:', e.message);
    }
  }

  return {
    isRunning: replayState.isRunning,
    deviceIds: replayState.deviceIds,
    startTime: replayState.startTime,
    endTime: replayState.endTime,
    speedMultiplier: replayState.speedMultiplier,
    startedAt: replayState.startedAt,
    currentReplayTime: replayState.currentReplayTime,
    progressPercent: progress,
    replayedCount: replayState.currentIndex,
    totalRecords: total,
    triggeredAlarmCount,
    triggeredInterlockCount
  };
}

module.exports = {
  startReplay,
  stopReplay,
  getStatus
};
