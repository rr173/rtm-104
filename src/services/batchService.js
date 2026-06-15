const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const batchStore = require('../store/batchStore');
const redundancyStore = require('../store/redundancyStore');
const alarmService = require('./alarmService');
const maintenanceService = require('./maintenanceService');

const SAMPLING_INTERVAL_MS = 5000;

async function createBatch(data) {
  if (!data.batchNo || typeof data.batchNo !== 'string') {
    return { success: false, error: '批次号不能为空' };
  }
  if (!data.productName || typeof data.productName !== 'string') {
    return { success: false, error: '产品名不能为空' };
  }
  if (!Array.isArray(data.deviceIds) || data.deviceIds.length === 0) {
    return { success: false, error: '关联设备列表不能为空' };
  }
  if (!Array.isArray(data.lockedRegisters) || data.lockedRegisters.length === 0) {
    return { success: false, error: '锁定寄存器清单不能为空' };
  }
  for (const reg of data.lockedRegisters) {
    if (!reg.deviceId || typeof reg.address !== 'number') {
      return { success: false, error: '每个锁定寄存器必须包含deviceId和address' };
    }
    if (!data.deviceIds.includes(reg.deviceId)) {
      return { success: false, error: `锁定寄存器设备${reg.deviceId}不在关联设备列表中` };
    }
    if (reg.upperLimit !== undefined && reg.lowerLimit !== undefined) {
      if (typeof reg.upperLimit !== 'number' || typeof reg.lowerLimit !== 'number') {
        return { success: false, error: '上下限必须为数字' };
      }
      if (reg.upperLimit <= reg.lowerLimit) {
        return { success: false, error: '上限必须大于下限' };
      }
      if (reg.maxDeviationSeconds !== undefined && (typeof reg.maxDeviationSeconds !== 'number' || reg.maxDeviationSeconds < 0)) {
        return { success: false, error: '最大偏差容忍时长必须为非负数字' };
      }
    } else if (reg.upperLimit !== undefined || reg.lowerLimit !== undefined) {
      return { success: false, error: '上下限必须同时设置或同时不设置' };
    }
  }

  for (const devId of data.deviceIds) {
    if (!deviceStore.hasDevice(devId)) {
      return { success: false, error: `设备不存在: ${devId}` };
    }
  }

  const existing = await get('SELECT id FROM batches WHERE batch_no = ?', [data.batchNo]);
  if (existing) {
    return { success: false, error: `批次号已存在: ${data.batchNo}` };
  }

  const id = uuidv4();
  const now = Date.now();

  await run(
    'INSERT INTO batches (id, batch_no, product_name, device_ids, locked_registers, planned_quantity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, data.batchNo, data.productName, JSON.stringify(data.deviceIds), JSON.stringify(data.lockedRegisters), data.plannedQuantity || 0, 'pending', now]
  );

  return { success: true, batch: await getBatchById(id) };
}

async function getBatchById(id) {
  const row = await get('SELECT * FROM batches WHERE id = ?', [id]);
  if (!row) return null;
  return formatBatch(row);
}

async function getAllBatches() {
  const rows = await all('SELECT * FROM batches ORDER BY created_at DESC');
  return rows.map(formatBatch);
}

function formatBatch(row) {
  return {
    id: row.id,
    batchNo: row.batch_no,
    productName: row.product_name,
    deviceIds: JSON.parse(row.device_ids),
    lockedRegisters: JSON.parse(row.locked_registers),
    plannedQuantity: row.planned_quantity,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at
  };
}

async function startBatch(id) {
  const batch = await getBatchById(id);
  if (!batch) {
    return { success: false, error: '批次不存在' };
  }
  if (batch.status !== 'pending') {
    return { success: false, error: '只有待启动的批次才能启动' };
  }
  if (batchStore.hasRunningBatch()) {
    return { success: false, error: `已有批次在运行中: ${batchStore.getRunningBatchId()}` };
  }

  const now = Date.now();
  await run('UPDATE batches SET status = ?, started_at = ? WHERE id = ?', ['running', now, id]);

  batchStore.setRunningBatch(id, batch.lockedRegisters);
  startSampling(id, batch.deviceIds);

  return { success: true, batch: await getBatchById(id) };
}

function startSampling(batchId, deviceIds) {
  const timer = setInterval(async () => {
    try {
      await takeSnapshot(batchId, deviceIds);
    } catch (e) {
      console.error('[批次] 采样失败:', e.message);
    }
  }, SAMPLING_INTERVAL_MS);
  batchStore.setSamplingTimer(timer);
  console.log(`[批次] 采样引擎已启动 (批次=${batchId}, 间隔=${SAMPLING_INTERVAL_MS}ms)`);
}

async function takeSnapshot(batchId, deviceIds) {
  const now = Date.now();
  const snapshotData = {};

  for (const devId of deviceIds) {
    const actualDeviceId = redundancyStore.getActiveDeviceId(devId);
    const regs = await all('SELECT * FROM registers WHERE device_id = ? ORDER BY address', [actualDeviceId]);
    const data = {};
    for (const reg of regs) {
      const { value } = deviceStore.getRegisterValue(actualDeviceId, reg.address, reg.data_type);
      data[reg.address] = value;
    }
    snapshotData[devId] = data;
    await run(
      'INSERT INTO batch_snapshots (batch_id, device_id, data, timestamp) VALUES (?, ?, ?, ?)',
      [batchId, devId, JSON.stringify(data), now]
    );
  }

  await checkDeviations(batchId, snapshotData, now);
}

async function checkDeviations(batchId, snapshotData, now) {
  const monitoredRegs = batchStore.getMonitoredRegisters();

  for (const reg of monitoredRegs) {
    const deviceData = snapshotData[reg.deviceId];
    if (!deviceData) continue;

    const value = deviceData[reg.address];
    if (value === undefined || value === null) continue;

    const isOutOfRange = value > reg.upperLimit || value < reg.lowerLimit;
    const hasActiveDeviation = batchStore.hasActiveDeviation(reg.deviceId, reg.address);

    if (isOutOfRange && !hasActiveDeviation) {
      await startDeviationEvent(batchId, reg, value, now);
    } else if (isOutOfRange && hasActiveDeviation) {
      await updateDeviationEvent(reg, value, now);
    } else if (!isOutOfRange && hasActiveDeviation) {
      await endDeviationEvent(batchId, reg, value, now);
    }
  }
}

async function startDeviationEvent(batchId, reg, value, now) {
  const maxDeviation = Math.max(
    Math.abs(value - reg.upperLimit),
    Math.abs(value - reg.lowerLimit)
  );

  const result = await run(
    `INSERT INTO batch_deviation_events 
     (batch_id, device_id, address, upper_limit, lower_limit, start_value, peak_value, max_deviation, started_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [batchId, reg.deviceId, reg.address, reg.upperLimit, reg.lowerLimit, value, value, maxDeviation, now]
  );

  batchStore.setActiveDeviation(reg.deviceId, reg.address, {
    eventId: result.lastID,
    upperLimit: reg.upperLimit,
    lowerLimit: reg.lowerLimit,
    startValue: value,
    peakValue: value,
    maxDeviation: maxDeviation,
    startedAt: now
  });

  console.log(`[工艺偏差] 参数超差开始: 设备=${reg.deviceId}, 地址=${reg.address}, 当前值=${value}, 范围=[${reg.lowerLimit}, ${reg.upperLimit}]`);
}

async function updateDeviationEvent(reg, value, now) {
  const active = batchStore.getActiveDeviation(reg.deviceId, reg.address);
  if (!active) return;

  const currentDeviation = Math.max(
    Math.abs(value - reg.upperLimit),
    Math.abs(value - reg.lowerLimit)
  );

  if (currentDeviation > active.maxDeviation) {
    active.peakValue = value;
    active.maxDeviation = currentDeviation;
    batchStore.setActiveDeviation(reg.deviceId, reg.address, active);

    await run(
      'UPDATE batch_deviation_events SET peak_value = ?, max_deviation = ? WHERE id = ?',
      [value, currentDeviation, active.eventId]
    );
  }
}

async function endDeviationEvent(batchId, reg, value, now) {
  const active = batchStore.getActiveDeviation(reg.deviceId, reg.address);
  if (!active) return;

  const durationSeconds = (now - active.startedAt) / 1000;

  await run(
    'UPDATE batch_deviation_events SET ended_at = ?, duration_seconds = ? WHERE id = ?',
    [now, durationSeconds, active.eventId]
  );

  batchStore.clearActiveDeviation(reg.deviceId, reg.address);

  console.log(`[工艺偏差] 参数超差结束: 设备=${reg.deviceId}, 地址=${reg.address}, 持续=${durationSeconds.toFixed(1)}秒, 最大偏离=${active.maxDeviation.toFixed(2)}`);
}

async function stopBatch(id) {
  const batch = await getBatchById(id);
  if (!batch) {
    return { success: false, error: '批次不存在' };
  }
  if (batch.status !== 'running') {
    return { success: false, error: '只有运行中的批次才能结束' };
  }
  if (batchStore.getRunningBatchId() !== id) {
    return { success: false, error: '该批次不是当前运行中的批次' };
  }

  batchStore.clearSamplingTimer();

  const now = Date.now();
  await run('UPDATE batches SET status = ?, ended_at = ? WHERE id = ?', ['completed', now, id]);

  await takeSnapshot(id, batch.deviceIds);

  await endAllActiveDeviations(id, batch, now);

  const report = await generateReport(id);

  batchStore.clearRunningBatch();

  return { success: true, batch: await getBatchById(id), report };
}

async function endAllActiveDeviations(batchId, batch, now) {
  const activeDeviations = batchStore.getAllActiveDeviations();
  for (const active of activeDeviations) {
    const reg = batch.lockedRegisters.find(
      r => r.deviceId === active.deviceId && r.address === active.address
    );
    if (reg) {
      const durationSeconds = (now - active.startedAt) / 1000;
      await run(
        'UPDATE batch_deviation_events SET ended_at = ?, duration_seconds = ? WHERE id = ?',
        [now, durationSeconds, active.eventId]
      );
      console.log(`[工艺偏差] 批次结束，参数超差强制结束: 设备=${active.deviceId}, 地址=${active.address}, 持续=${durationSeconds.toFixed(1)}秒`);
    }
  }
}

async function generateReport(batchId) {
  const batch = await getBatchById(batchId);
  if (!batch) return null;

  const startTime = batch.startedAt;
  const endTime = batch.endedAt;
  const durationSeconds = (endTime - startTime) / 1000;

  const paramStats = [];
  for (const reg of batch.lockedRegisters) {
    const snapshots = await all(
      'SELECT data, timestamp FROM batch_snapshots WHERE batch_id = ? AND device_id = ? ORDER BY timestamp',
      [batchId, reg.deviceId]
    );

    const values = [];
    for (const snap of snapshots) {
      const data = JSON.parse(snap.data);
      if (data[reg.address] !== undefined) {
        values.push(data[reg.address]);
      }
    }

    let startValue = null;
    let endValue = null;
    let min = null;
    let max = null;
    let sum = 0;

    if (values.length > 0) {
      startValue = values[0];
      endValue = values[values.length - 1];
      min = Math.min(...values);
      max = Math.max(...values);
      sum = values.reduce((a, b) => a + b, 0);
    }

    const regInfo = await get(
      'SELECT name, data_type FROM registers WHERE device_id = ? AND address = ?',
      [reg.deviceId, reg.address]
    );

    paramStats.push({
      deviceId: reg.deviceId,
      address: reg.address,
      registerName: regInfo ? regInfo.name : `reg${reg.address}`,
      startValue,
      endValue,
      min,
      max,
      avg: values.length > 0 ? sum / values.length : null
    });
  }

  const paramChanges = await all(
    'SELECT * FROM batch_param_changes WHERE batch_id = ? ORDER BY timestamp',
    [batchId]
  );
  const paramChangesDetail = paramChanges.map(pc => ({
    deviceId: pc.device_id,
    address: pc.address,
    oldValue: pc.old_value,
    newValue: pc.new_value,
    reason: pc.reason,
    timestamp: pc.timestamp
  }));

  let alarmCount = 0;
  const alarmSummary = [];
  for (const devId of batch.deviceIds) {
    const alarms = await alarmService.getAlarmHistory(devId, startTime, endTime);
    for (const a of alarms) {
      if (a.triggeredAt >= startTime && a.triggeredAt <= endTime) {
        alarmCount++;
        alarmSummary.push({
          deviceId: a.deviceId,
          deviceName: a.deviceName,
          regAddress: a.regAddress,
          regName: a.regName,
          alarmType: a.alarmType,
          threshold: a.threshold,
          currentValue: a.currentValue,
          triggeredAt: a.triggeredAt,
          recoveredAt: a.recoveredAt,
          active: a.active
        });
      }
    }
  }

  const deviationStats = [];
  let processQualified = true;

  for (const reg of batch.lockedRegisters) {
    if (reg.upperLimit === undefined || reg.lowerLimit === undefined) continue;

    const events = await all(
      'SELECT * FROM batch_deviation_events WHERE batch_id = ? AND device_id = ? AND address = ? ORDER BY started_at',
      [batchId, reg.deviceId, reg.address]
    );

    const deviationCount = events.length;
    let totalDurationSeconds = 0;
    let maxDeviation = 0;

    for (const evt of events) {
      if (evt.duration_seconds !== null) {
        totalDurationSeconds += evt.duration_seconds;
      }
      if (evt.max_deviation > maxDeviation) {
        maxDeviation = evt.max_deviation;
      }
    }

    const regInfo = await get(
      'SELECT name FROM registers WHERE device_id = ? AND address = ?',
      [reg.deviceId, reg.address]
    );

    const maxDeviationSeconds = reg.maxDeviationSeconds !== undefined ? reg.maxDeviationSeconds : 0;
    if (maxDeviationSeconds > 0 && totalDurationSeconds > maxDeviationSeconds) {
      processQualified = false;
    }

    deviationStats.push({
      deviceId: reg.deviceId,
      address: reg.address,
      registerName: regInfo ? regInfo.name : `reg${reg.address}`,
      upperLimit: reg.upperLimit,
      lowerLimit: reg.lowerLimit,
      maxDeviationSeconds: maxDeviationSeconds,
      deviationCount,
      totalDurationSeconds,
      maxDeviation
    });
  }

  const reportId = uuidv4();
  const now = Date.now();

  await run(
    'INSERT INTO batch_reports (id, batch_id, start_time, end_time, duration_seconds, param_stats, param_changes_count, param_changes_detail, alarm_count, alarm_summary, deviation_stats, process_qualified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      reportId, batchId, startTime, endTime, durationSeconds,
      JSON.stringify(paramStats),
      paramChanges.length,
      JSON.stringify(paramChangesDetail),
      alarmCount,
      JSON.stringify(alarmSummary),
      JSON.stringify(deviationStats),
      processQualified ? 1 : 0,
      now
    ]
  );

  return {
    id: reportId,
    batchId,
    startTime,
    endTime,
    durationSeconds,
    paramStats,
    paramChangesCount: paramChanges.length,
    paramChangesDetail,
    alarmCount,
    alarmSummary,
    deviationStats,
    processQualified,
    createdAt: now
  };
}

async function changeBatchParam(batchId, data) {
  if (!data.deviceId || typeof data.address !== 'number' || typeof data.newValue !== 'number') {
    return { success: false, error: '必须提供deviceId、address和newValue' };
  }
  if (!data.reason || typeof data.reason !== 'string' || data.reason.trim() === '') {
    return { success: false, error: '批次参数变更必须填写变更原因' };
  }

  if (batchStore.getRunningBatchId() !== batchId) {
    return { success: false, error: '该批次不是当前运行中的批次' };
  }

  const redundancyService = require('./redundancyService');
  const resolved = redundancyService.resolveDeviceForOperation(data.deviceId);
  if (resolved.inDegraded) {
    return { success: false, error: `主备组[${resolved.groupName}]当前处于降级状态，没有可接管设备` };
  }

  const actualDeviceId = resolved.deviceId;

  if (!isRegisterLocked(data.deviceId, data.address)) {
    return { success: false, error: '该寄存器未被批次锁定，请使用普通写入接口' };
  }

  if (maintenanceService.isDeviceLocked(data.deviceId)) {
    return { success: false, error: '设备维保中' };
  }

  if (maintenanceService.isDeviceLocked(actualDeviceId)) {
    return { success: false, error: '设备维保中' };
  }

  const reg = await get('SELECT * FROM registers WHERE device_id = ? AND address = ?', [actualDeviceId, data.address]);
  if (!reg) {
    return { success: false, error: '寄存器不存在' };
  }
  if (reg.rw !== 'RW') {
    return { success: false, error: '该寄存器为只读' };
  }

  const { value: oldValue } = deviceStore.getRegisterValue(actualDeviceId, data.address, reg.data_type);

  const now = Date.now();
  await run(
    'INSERT INTO batch_param_changes (batch_id, device_id, address, old_value, new_value, reason, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [batchId, actualDeviceId, data.address, oldValue, data.newValue, data.reason.trim(), now]
  );

  deviceStore.setRegisterValue(actualDeviceId, data.address, reg.data_type, data.newValue);

  try {
    await redundancyService.notifyRegisterWritten(actualDeviceId, data.address, reg.data_type, data.newValue);
  } catch (syncErr) {
    console.error('[batchService] 批次参数变更后热同步备用机失败:', syncErr.message);
  }

  return {
    success: true,
    change: {
      deviceId: actualDeviceId,
      originalDeviceId: data.deviceId,
      address: data.address,
      oldValue,
      newValue: data.newValue,
      reason: data.reason.trim(),
      timestamp: now
    }
  };
}

async function getBatchProcessData(batchId, query) {
  const batch = await getBatchById(batchId);
  if (!batch) {
    return { success: false, error: '批次不存在' };
  }

  let sql = 'SELECT * FROM batch_snapshots WHERE batch_id = ?';
  const params = [batchId];

  if (query.deviceId) {
    sql += ' AND device_id = ?';
    params.push(query.deviceId);
  }
  if (query.startTime) {
    sql += ' AND timestamp >= ?';
    params.push(parseInt(query.startTime));
  }
  if (query.endTime) {
    sql += ' AND timestamp <= ?';
    params.push(parseInt(query.endTime));
  }
  sql += ' ORDER BY timestamp ASC';

  const rows = await all(sql, params);

  const snapshots = rows.map(r => {
    const data = JSON.parse(r.data);
    const result = {
      deviceId: r.device_id,
      timestamp: r.timestamp,
      registers: {}
    };
    if (query.regAddress !== undefined) {
      const addr = parseInt(query.regAddress);
      if (data[addr] !== undefined) {
        result.registers[addr] = data[addr];
      }
    } else {
      result.registers = data;
    }
    return result;
  });

  return { success: true, data: snapshots };
}

async function getBatchReport(batchId) {
  const row = await get('SELECT * FROM batch_reports WHERE batch_id = ?', [batchId]);
  if (!row) return null;
  return {
    id: row.id,
    batchId: row.batch_id,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.duration_seconds,
    paramStats: JSON.parse(row.param_stats),
    paramChangesCount: row.param_changes_count,
    paramChangesDetail: JSON.parse(row.param_changes_detail),
    alarmCount: row.alarm_count,
    alarmSummary: JSON.parse(row.alarm_summary),
    deviationStats: JSON.parse(row.deviation_stats || '[]'),
    processQualified: row.process_qualified === 1,
    createdAt: row.created_at
  };
}

async function getDeviationEvents(batchId) {
  const batch = await getBatchById(batchId);
  if (!batch) return { success: false, error: '批次不存在' };

  const rows = await all(
    'SELECT * FROM batch_deviation_events WHERE batch_id = ? ORDER BY started_at DESC',
    [batchId]
  );

  const events = rows.map(row => ({
    id: row.id,
    deviceId: row.device_id,
    address: row.address,
    upperLimit: row.upper_limit,
    lowerLimit: row.lower_limit,
    startValue: row.start_value,
    peakValue: row.peak_value,
    maxDeviation: row.max_deviation,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    active: row.ended_at === null
  }));

  return { success: true, data: events };
}

async function getCurrentDeviationStatus() {
  if (!batchStore.hasRunningBatch()) {
    return { success: false, error: '当前没有运行中的批次' };
  }

  const batchId = batchStore.getRunningBatchId();
  const activeDeviations = batchStore.getAllActiveDeviations();
  const now = Date.now();

  const result = [];
  for (const d of activeDeviations) {
    const regInfo = await get(
      'SELECT name, data_type FROM registers WHERE device_id = ? AND address = ?',
      [d.deviceId, d.address]
    );
    const actualDeviceId = redundancyStore.getActiveDeviceId(d.deviceId);
    const dataType = regInfo ? regInfo.data_type : 'REAL';
    const currentValue = deviceStore.getRegisterValue(actualDeviceId, d.address, dataType).value;
    result.push({
      deviceId: d.deviceId,
      actualDeviceId: actualDeviceId,
      address: d.address,
      registerName: regInfo ? regInfo.name : `reg${d.address}`,
      upperLimit: d.upperLimit,
      lowerLimit: d.lowerLimit,
      currentValue: currentValue,
      maxDeviation: d.maxDeviation,
      startedAt: d.startedAt,
      durationSeconds: (now - d.startedAt) / 1000
    });
  }

  return {
    success: true,
    data: {
      batchId,
      activeDeviations: result
    }
  };
}

async function getBatchParamChanges(batchId) {
  const rows = await all(
    'SELECT * FROM batch_param_changes WHERE batch_id = ? ORDER BY timestamp',
    [batchId]
  );
  return rows.map(pc => ({
    id: pc.id,
    deviceId: pc.device_id,
    address: pc.address,
    oldValue: pc.old_value,
    newValue: pc.new_value,
    reason: pc.reason,
    timestamp: pc.timestamp
  }));
}

function isRegisterLocked(deviceId, address) {
  if (batchStore.isRegisterLocked(deviceId, address)) {
    return true;
  }

  const group = redundancyStore.getGroupByDevice(deviceId);
  if (group) {
    const memberIds = [group.primaryDeviceId, group.backupDeviceId];
    if (group.currentPrimaryId) {
      memberIds.push(group.currentPrimaryId);
    }
    for (const mid of memberIds) {
      if (mid && mid !== deviceId && batchStore.isRegisterLocked(mid, address)) {
        return true;
      }
    }
  }
  return false;
}

async function restoreRunningBatch() {
  const row = await get("SELECT * FROM batches WHERE status = 'running'");
  if (!row) return 0;

  const batch = formatBatch(row);
  batchStore.setRunningBatch(batch.id, batch.lockedRegisters);

  const activeEvents = await all(
    'SELECT * FROM batch_deviation_events WHERE batch_id = ? AND ended_at IS NULL',
    [batch.id]
  );
  for (const evt of activeEvents) {
    batchStore.setActiveDeviation(evt.device_id, evt.address, {
      eventId: evt.id,
      upperLimit: evt.upper_limit,
      lowerLimit: evt.lower_limit,
      startValue: evt.start_value,
      peakValue: evt.peak_value,
      maxDeviation: evt.max_deviation,
      startedAt: evt.started_at
    });
  }

  startSampling(batch.id, batch.deviceIds);
  console.log(`[批次] 恢复运行中批次: ${batch.batchNo} (${batch.id}), 活动偏差数: ${activeEvents.length}`);
  return 1;
}

function stopEngine() {
  batchStore.clearSamplingTimer();
}

module.exports = {
  createBatch,
  getBatchById,
  getAllBatches,
  startBatch,
  stopBatch,
  changeBatchParam,
  getBatchProcessData,
  getBatchReport,
  getBatchParamChanges,
  getDeviationEvents,
  getCurrentDeviationStatus,
  isRegisterLocked,
  restoreRunningBatch,
  stopEngine,
  generateReport
};
