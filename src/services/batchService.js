const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const batchStore = require('../store/batchStore');
const alarmService = require('./alarmService');

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
  for (const devId of deviceIds) {
    const regs = await all('SELECT * FROM registers WHERE device_id = ? ORDER BY address', [devId]);
    const data = {};
    for (const reg of regs) {
      const { value } = deviceStore.getRegisterValue(devId, reg.address, reg.data_type);
      data[reg.address] = value;
    }
    await run(
      'INSERT INTO batch_snapshots (batch_id, device_id, data, timestamp) VALUES (?, ?, ?, ?)',
      [batchId, devId, JSON.stringify(data), now]
    );
  }
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

  const report = await generateReport(id);

  batchStore.clearRunningBatch();

  return { success: true, batch: await getBatchById(id), report };
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

  const reportId = uuidv4();
  const now = Date.now();

  await run(
    'INSERT INTO batch_reports (id, batch_id, start_time, end_time, duration_seconds, param_stats, param_changes_count, param_changes_detail, alarm_count, alarm_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      reportId, batchId, startTime, endTime, durationSeconds,
      JSON.stringify(paramStats),
      paramChanges.length,
      JSON.stringify(paramChangesDetail),
      alarmCount,
      JSON.stringify(alarmSummary),
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

  if (!batchStore.isRegisterLocked(data.deviceId, data.address)) {
    return { success: false, error: '该寄存器未被批次锁定，请使用普通写入接口' };
  }

  const reg = await get('SELECT * FROM registers WHERE device_id = ? AND address = ?', [data.deviceId, data.address]);
  if (!reg) {
    return { success: false, error: '寄存器不存在' };
  }
  if (reg.rw !== 'RW') {
    return { success: false, error: '该寄存器为只读' };
  }

  const { value: oldValue } = deviceStore.getRegisterValue(data.deviceId, data.address, reg.data_type);

  const now = Date.now();
  await run(
    'INSERT INTO batch_param_changes (batch_id, device_id, address, old_value, new_value, reason, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [batchId, data.deviceId, data.address, oldValue, data.newValue, data.reason.trim(), now]
  );

  deviceStore.setRegisterValue(data.deviceId, data.address, reg.data_type, data.newValue);

  return {
    success: true,
    change: {
      deviceId: data.deviceId,
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
    createdAt: row.created_at
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
  return batchStore.isRegisterLocked(deviceId, address);
}

async function restoreRunningBatch() {
  const row = await get("SELECT * FROM batches WHERE status = 'running'");
  if (!row) return 0;

  const batch = formatBatch(row);
  batchStore.setRunningBatch(batch.id, batch.lockedRegisters);
  startSampling(batch.id, batch.deviceIds);
  console.log(`[批次] 恢复运行中批次: ${batch.batchNo} (${batch.id})`);
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
  isRegisterLocked,
  restoreRunningBatch,
  stopEngine,
  generateReport
};
