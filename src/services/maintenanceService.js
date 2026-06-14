const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const maintenanceStore = require('../store/maintenanceStore');
const redundancyService = require('./redundancyService');

const VALID_TYPES = ['planned', 'emergency'];
const VALID_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'];
const SCAN_INTERVAL_MS = 10000;

function validateCreateOrder(body) {
  if (!body.deviceId) return '缺少deviceId';
  if (!deviceStore.hasDevice(body.deviceId)) return '设备不存在';
  if (!body.maintenanceType || !VALID_TYPES.includes(body.maintenanceType)) {
    return 'maintenanceType必须是planned或emergency';
  }
  if (body.maintenanceType === 'planned') {
    if (typeof body.plannedStartAt !== 'number' || body.plannedStartAt <= 0) {
      return 'planned类型必须提供有效的plannedStartAt时间戳';
    }
    if (typeof body.plannedEndAt !== 'number' || body.plannedEndAt <= body.plannedStartAt) {
      return 'planned类型必须提供大于plannedStartAt的plannedEndAt';
    }
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    return 'description必须是字符串';
  }
  if (body.responsiblePerson !== undefined && typeof body.responsiblePerson !== 'string') {
    return 'responsiblePerson必须是字符串';
  }
  return null;
}

function formatOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    deviceId: row.device_id,
    maintenanceType: row.maintenance_type,
    status: row.status,
    plannedStartAt: row.planned_start_at,
    plannedEndAt: row.planned_end_at,
    actualStartAt: row.actual_start_at,
    actualEndAt: row.actual_end_at,
    description: row.description,
    responsiblePerson: row.responsible_person,
    createdAt: row.created_at,
    deviceLocked: maintenanceStore.isDeviceLocked(row.device_id)
  };
}

async function logEvent(orderId, deviceId, eventType, eventData = null) {
  const now = Date.now();
  await run(
    `INSERT INTO maintenance_events (order_id, device_id, event_type, event_data, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
    [orderId, deviceId, eventType, eventData ? JSON.stringify(eventData) : null, now]
  );
}

async function hasActiveInProgressOrder(deviceId, excludeOrderId = null) {
  const sql = `SELECT id FROM maintenance_orders WHERE device_id = ? AND status = 'in_progress'`;
  const params = [deviceId];
  const row = excludeOrderId
    ? await get(sql + ` AND id != ?`, [...params, excludeOrderId])
    : await get(sql, params);
  return !!row;
}

async function createOrder(body) {
  const err = validateCreateOrder(body);
  if (err) return { success: false, error: err, code: 400 };

  const id = uuidv4();
  const now = Date.now();
  const type = body.maintenanceType;

  let status = 'scheduled';
  let plannedStartAt = body.plannedStartAt || null;
  let plannedEndAt = body.plannedEndAt || null;
  let actualStartAt = null;

  if (type === 'emergency') {
    status = 'in_progress';
    plannedStartAt = now;
    plannedEndAt = body.plannedEndAt || (now + 3600 * 1000);
    actualStartAt = now;

    const conflict = await hasActiveInProgressOrder(body.deviceId);
    if (conflict) {
      return {
        success: false,
        error: '该设备已有正在进行的维保工单，无法创建紧急维保',
        code: 409
      };
    }
  }

  await run(
    `INSERT INTO maintenance_orders (
      id, device_id, maintenance_type, status,
      planned_start_at, planned_end_at, actual_start_at, actual_end_at,
      description, responsible_person, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      id, body.deviceId, type, status,
      plannedStartAt, plannedEndAt, actualStartAt,
      body.description || null, body.responsiblePerson || null, now
    ]
  );

  if (type === 'emergency') {
    maintenanceStore.lockDevice(body.deviceId, id);
    await logEvent(id, body.deviceId, 'lock_device', { reason: 'emergency_created' });
    console.log(`[维保] 紧急维保工单已创建并锁定设备: orderId=${id}, deviceId=${body.deviceId}`);
    try {
      await redundancyService.checkAndSwitchForDevice(
        body.deviceId,
        redundancyService.SWITCH_REASONS.MAINTENANCE_START,
        `紧急维保工单创建: ${id}`
      );
    } catch (e) {
      console.error('[冗余] 维保锁定触发切换出错:', e.message);
    }
  } else {
    await logEvent(id, body.deviceId, 'created_scheduled', {
      plannedStartAt, plannedEndAt
    });
    console.log(`[维保] 计划维保工单已创建: orderId=${id}, deviceId=${body.deviceId}`);
  }

  return { success: true, order: await getOrderById(id) };
}

async function getOrderById(id) {
  const row = await get('SELECT * FROM maintenance_orders WHERE id = ?', [id]);
  return formatOrder(row);
}

async function listOrders(query = {}) {
  let sql = 'SELECT * FROM maintenance_orders WHERE 1=1';
  const params = [];

  if (query.status) {
    sql += ' AND status = ?';
    params.push(query.status);
  }
  if (query.deviceId) {
    sql += ' AND device_id = ?';
    params.push(query.deviceId);
  }
  if (query.maintenanceType) {
    sql += ' AND maintenance_type = ?';
    params.push(query.maintenanceType);
  }

  sql += ' ORDER BY created_at DESC';

  const rows = await all(sql, params);
  return rows.map(formatOrder);
}

async function startOrder(id) {
  const order = await get('SELECT * FROM maintenance_orders WHERE id = ?', [id]);
  if (!order) return { success: false, error: '工单不存在', code: 404 };

  if (order.status !== 'scheduled') {
    return {
      success: false,
      error: `只有scheduled状态的工单可以开始，当前状态: ${order.status}`,
      code: 400
    };
  }

  const conflict = await hasActiveInProgressOrder(order.device_id, id);
  if (conflict) {
    return {
      success: false,
      error: '该设备已有正在进行的维保工单',
      code: 409
    };
  }

  const now = Date.now();
  await run(
    `UPDATE maintenance_orders SET status = 'in_progress', actual_start_at = ? WHERE id = ?`,
    [now, id]
  );

  maintenanceStore.lockDevice(order.device_id, id);
  await logEvent(id, order.device_id, 'lock_device', { reason: 'order_started', startedAt: now });
  console.log(`[维保] 工单开始，设备已锁定: orderId=${id}, deviceId=${order.device_id}`);
  try {
    await redundancyService.checkAndSwitchForDevice(
      order.device_id,
      redundancyService.SWITCH_REASONS.MAINTENANCE_START,
      `维保工单开始: ${id}`
    );
  } catch (e) {
    console.error('[冗余] 维保开始触发切换出错:', e.message);
  }

  return { success: true, order: await getOrderById(id) };
}

async function completeOrder(id) {
  const order = await get('SELECT * FROM maintenance_orders WHERE id = ?', [id]);
  if (!order) return { success: false, error: '工单不存在', code: 404 };

  if (order.status !== 'in_progress') {
    return {
      success: false,
      error: `只有in_progress状态的工单可以完成，当前状态: ${order.status}`,
      code: 400
    };
  }

  const now = Date.now();
  await run(
    `UPDATE maintenance_orders SET status = 'completed', actual_end_at = ? WHERE id = ?`,
    [now, id]
  );

  const wasLocked = maintenanceStore.isDeviceLocked(order.device_id);
  if (wasLocked && maintenanceStore.getLockInfo(order.device_id).orderId === id) {
    maintenanceStore.unlockDevice(order.device_id);
  }

  await logEvent(id, order.device_id, 'unlock_device', { reason: 'order_completed', endedAt: now });
  console.log(`[维保] 工单完成，设备已解锁: orderId=${id}, deviceId=${order.device_id}`);
  try {
    await redundancyService.checkDeviceRecovery(order.device_id);
  } catch (e) {
    console.error('[冗余] 维保完成设备恢复检查出错:', e.message);
  }

  return { success: true, order: await getOrderById(id) };
}

async function cancelOrder(id) {
  const order = await get('SELECT * FROM maintenance_orders WHERE id = ?', [id]);
  if (!order) return { success: false, error: '工单不存在', code: 404 };

  if (order.status === 'completed' || order.status === 'cancelled') {
    return {
      success: false,
      error: `该状态的工单无法取消: ${order.status}`,
      code: 400
    };
  }

  const now = Date.now();
  const wasInProgress = order.status === 'in_progress';

  await run(
    `UPDATE maintenance_orders SET status = 'cancelled', actual_end_at = ? WHERE id = ?`,
    [now, id]
  );

  if (wasInProgress) {
    const lockInfo = maintenanceStore.getLockInfo(order.device_id);
    if (lockInfo && lockInfo.orderId === id) {
      maintenanceStore.unlockDevice(order.device_id);
      await logEvent(id, order.device_id, 'unlock_device', { reason: 'order_cancelled', endedAt: now });
      try {
        await redundancyService.checkDeviceRecovery(order.device_id);
      } catch (e) {
        console.error('[冗余] 维保取消设备恢复检查出错:', e.message);
      }
    }
  }

  await logEvent(id, order.device_id, 'cancelled', { cancelledAt: now, wasInProgress });
  console.log(`[维保] 工单已取消: orderId=${id}, deviceId=${order.device_id}`);

  return { success: true, order: await getOrderById(id) };
}

async function scanScheduledOrders() {
  const now = Date.now();
  const scheduled = await all(`SELECT * FROM maintenance_orders WHERE status = 'scheduled'`);

  for (const order of scheduled) {
    if (order.planned_start_at && now >= order.planned_start_at) {
      const conflict = await hasActiveInProgressOrder(order.device_id, order.id);
      if (!conflict) {
        console.log(`[维保调度] 到达计划开始时间，自动启动工单: ${order.id}`);
        await startOrder(order.id);
      }
    }
  }

  const inProgress = await all(`SELECT * FROM maintenance_orders WHERE status = 'in_progress'`);
  for (const order of inProgress) {
    if (order.planned_end_at && now >= order.planned_end_at) {
      console.log(`[维保调度] 超过计划结束时间，自动完成工单: ${order.id}`);
      await completeOrder(order.id);
    }
  }
}

let scanTimer = null;

function startEngine() {
  if (scanTimer) return;
  scanTimer = setInterval(() => {
    scanScheduledOrders().catch(e => console.error('维保调度扫描错误:', e));
  }, SCAN_INTERVAL_MS);
  maintenanceStore.setTimer(scanTimer);
  console.log(`维保调度引擎已启动 (扫描间隔 ${SCAN_INTERVAL_MS}ms)`);
}

function stopEngine() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  maintenanceStore.clearTimer();
}

async function getEvents(orderId, limit = 100) {
  const n = Math.min(Math.max(parseInt(limit) || 100, 1), 1000);
  let sql = `SELECT * FROM maintenance_events WHERE 1=1`;
  const params = [];
  if (orderId) {
    sql += ' AND order_id = ?';
    params.push(orderId);
  }
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(n);

  const rows = await all(sql, params);
  return rows.map(r => ({
    id: r.id,
    orderId: r.order_id,
    deviceId: r.device_id,
    eventType: r.event_type,
    eventData: r.event_data ? JSON.parse(r.event_data) : null,
    timestamp: r.timestamp
  }));
}

async function getStats(query = {}) {
  const { deviceId, startDate, endDate } = query;
  const now = Date.now();

  let sql = `SELECT * FROM maintenance_orders WHERE 1=1`;
  const params = [];

  if (deviceId) {
    sql += ' AND device_id = ?';
    params.push(deviceId);
  }

  const rows = await all(sql, params);

  let totalDowntimeMs = 0;
  let plannedDowntimeMs = 0;
  let emergencyDowntimeMs = 0;
  let orderCount = 0;
  const completedDurations = [];

  for (const order of rows) {
    if (order.status === 'scheduled') continue;

    const fullStartAt = order.actual_start_at || order.created_at;
    let fullEndAt = order.actual_end_at;
    if (order.status === 'in_progress') {
      fullEndAt = now;
    }

    if (!fullStartAt || !fullEndAt || fullEndAt <= fullStartAt) continue;

    let effStart = fullStartAt;
    let effEnd = fullEndAt;

    if (startDate) {
      effStart = Math.max(effStart, startDate);
    }
    if (endDate) {
      effEnd = Math.min(effEnd, endDate);
    }

    const clippedDuration = effEnd - effStart;
    if (clippedDuration <= 0) continue;

    orderCount++;

    const fullDuration = fullEndAt - fullStartAt;
    totalDowntimeMs += clippedDuration;

    if (order.maintenance_type === 'planned') {
      plannedDowntimeMs += clippedDuration;
    } else {
      emergencyDowntimeMs += clippedDuration;
    }

    if (order.status === 'completed') {
      completedDurations.push(fullDuration);
    }
  }

  const avgDurationMs = completedDurations.length > 0
    ? completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length
    : 0;

  return {
    deviceId: deviceId || null,
    startDate: startDate || null,
    endDate: endDate || null,
    orderCount,
    totalDowntimeMs,
    totalDowntimeHours: totalDowntimeMs / 3600000,
    plannedDowntimeMs,
    plannedDowntimeHours: plannedDowntimeMs / 3600000,
    emergencyDowntimeMs,
    emergencyDowntimeHours: emergencyDowntimeMs / 3600000,
    completedOrderCount: completedDurations.length,
    avgDurationMs,
    avgDurationMinutes: avgDurationMs / 60000
  };
}

function isDeviceLocked(deviceId) {
  return maintenanceStore.isDeviceLocked(deviceId);
}

function getDeviceLockInfo(deviceId) {
  return maintenanceStore.getLockInfo(deviceId);
}

async function logSuppressedInterlock(deviceId, interlockId, interlockName) {
  const lockInfo = maintenanceStore.getLockInfo(deviceId);
  if (!lockInfo) return;
  await logEvent(lockInfo.orderId, deviceId, 'suppressed_interlock', {
    interlockId,
    interlockName,
    suppressedAt: Date.now()
  });
  console.log(`[维保抑制] 联锁动作被维保锁定抑制: interlock=${interlockName}, device=${deviceId}`);
}

async function logBlockedSequence(deviceId, sequenceId, stepNumber) {
  const lockInfo = maintenanceStore.getLockInfo(deviceId);
  if (!lockInfo) return;
  await logEvent(lockInfo.orderId, deviceId, 'blocked_sequence_step', {
    sequenceId,
    stepNumber,
    blockedAt: Date.now()
  });
}

async function loadOrdersFromDB() {
  const inProgress = await all(`SELECT * FROM maintenance_orders WHERE status = 'in_progress'`);
  for (const order of inProgress) {
    maintenanceStore.lockDevice(order.device_id, order.id);
  }
  return inProgress.length;
}

module.exports = {
  createOrder,
  getOrderById,
  listOrders,
  startOrder,
  completeOrder,
  cancelOrder,
  getEvents,
  getStats,
  startEngine,
  stopEngine,
  scanScheduledOrders,
  isDeviceLocked,
  getDeviceLockInfo,
  logSuppressedInterlock,
  logBlockedSequence,
  loadOrdersFromDB,
  VALID_TYPES,
  VALID_STATUSES
};
