const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const shiftDutyStore = require('../store/shiftDutyStore');

const VALID_LEVELS = ['normal', 'important', 'critical'];
const VALID_EVENT_CATEGORIES = ['alarm', 'interlock', 'maintenance', 'batch', 'handover_timeout'];
const SCAN_INTERVAL_MS = 60000;
const HANDOVER_TIMEOUT_MINUTES = 15;

function minutesOfDay(hour, minute) {
  return hour * 60 + minute;
}

function shiftContainsTime(shift, ts) {
  const d = new Date(ts);
  const curMin = minutesOfDay(d.getHours(), d.getMinutes());
  const startMin = minutesOfDay(shift.start_hour, shift.start_minute || 0);
  const endMin = minutesOfDay(shift.end_hour, shift.end_minute || 0);
  const crossDay = shift.cross_day;

  if (!crossDay) {
    return curMin >= startMin && curMin < endMin;
  }
  return curMin >= startMin || curMin < endMin;
}

function getShiftDate(shift, ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  if (!shift.cross_day) {
    return `${y}-${m}-${day}`;
  }

  const curMin = minutesOfDay(d.getHours(), d.getMinutes());
  const startMin = minutesOfDay(shift.start_hour, shift.start_minute || 0);

  if (curMin < startMin) {
    const prev = new Date(ts);
    prev.setDate(prev.getDate() - 1);
    const py = prev.getFullYear();
    const pm = String(prev.getMonth() + 1).padStart(2, '0');
    const pd = String(prev.getDate()).padStart(2, '0');
    return `${py}-${pm}-${pd}`;
  }

  return `${y}-${m}-${day}`;
}

function getShiftEndTimestamp(shift, shiftDate) {
  const [y, m, d] = shiftDate.split('-').map(Number);
  const eh = shift.end_hour;
  const em = shift.end_minute || 0;
  const dt = new Date(y, m - 1, d, eh, em, 0, 0);
  if (shift.cross_day) {
    dt.setDate(dt.getDate() + 1);
  }
  return dt.getTime();
}

function formatShift(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    startHour: row.start_hour,
    startMinute: row.start_minute || 0,
    endHour: row.end_hour,
    endMinute: row.end_minute || 0,
    crossDay: !!row.cross_day,
    enabled: !!row.enabled,
    createdAt: row.created_at
  };
}

function formatLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    shiftId: row.shift_id,
    shiftName: row.shift_name,
    shiftDate: row.shift_date,
    status: row.status,
    createdAt: row.created_at
  };
}

function formatEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    logId: row.log_id,
    entryType: row.entry_type,
    content: row.content,
    deviceId: row.device_id,
    level: row.level,
    eventCategory: row.event_category,
    sourceEventId: row.source_event_id,
    editable: !!row.editable,
    timestamp: row.timestamp
  };
}

function formatHandover(row) {
  if (!row) return null;
  return {
    id: row.id,
    logId: row.log_id,
    handoverPerson: row.handover_person,
    receiverPerson: row.receiver_person,
    remarks: row.remarks,
    status: row.status,
    rejectReason: row.reject_reason,
    handoverAt: row.handover_at,
    confirmedAt: row.confirmed_at,
    rejectedAt: row.rejected_at
  };
}

async function createShift(body) {
  if (!body.name || typeof body.name !== 'string') {
    return { success: false, error: '班次名称不能为空', code: 400 };
  }
  if (typeof body.startHour !== 'number' || body.startHour < 0 || body.startHour > 23) {
    return { success: false, error: 'startHour必须是0-23之间的整数', code: 400 };
  }
  if (typeof body.endHour !== 'number' || body.endHour < 0 || body.endHour > 23) {
    return { success: false, error: 'endHour必须是0-23之间的整数', code: 400 };
  }
  if (body.startMinute !== undefined && (typeof body.startMinute !== 'number' || body.startMinute < 0 || body.startMinute > 59)) {
    return { success: false, error: 'startMinute必须是0-59之间的整数', code: 400 };
  }
  if (body.endMinute !== undefined && (typeof body.endMinute !== 'number' || body.endMinute < 0 || body.endMinute > 59)) {
    return { success: false, error: 'endMinute必须是0-59之间的整数', code: 400 };
  }

  const startMin = minutesOfDay(body.startHour, body.startMinute || 0);
  const endMin = minutesOfDay(body.endHour, body.endMinute || 0);
  const crossDay = body.crossDay !== undefined ? body.crossDay : (startMin >= endMin);

  const id = uuidv4();
  const now = Date.now();

  await run(
    `INSERT INTO duty_shifts (id, name, start_hour, start_minute, end_hour, end_minute, cross_day, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, body.name, body.startHour, body.startMinute || 0, body.endHour, body.endMinute || 0, crossDay ? 1 : 0, body.enabled !== false ? 1 : 0, now]
  );

  return { success: true, shift: await getShiftById(id) };
}

async function getShiftById(id) {
  const row = await get('SELECT * FROM duty_shifts WHERE id = ?', [id]);
  return formatShift(row);
}

async function getAllShifts() {
  const rows = await all('SELECT * FROM duty_shifts ORDER BY start_hour, start_minute');
  return rows.map(formatShift);
}

async function updateShift(id, body) {
  const existing = await get('SELECT * FROM duty_shifts WHERE id = ?', [id]);
  if (!existing) return { success: false, error: '班次不存在', code: 404 };

  const updates = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.startHour !== undefined) updates.start_hour = body.startHour;
  if (body.startMinute !== undefined) updates.start_minute = body.startMinute;
  if (body.endHour !== undefined) updates.end_hour = body.endHour;
  if (body.endMinute !== undefined) updates.end_minute = body.endMinute;
  if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;

  if (body.startHour !== undefined || body.startMinute !== undefined ||
      body.endHour !== undefined || body.endMinute !== undefined) {
    const sh = updates.start_hour !== undefined ? updates.start_hour : existing.start_hour;
    const sm = updates.start_minute !== undefined ? updates.start_minute : existing.start_minute;
    const eh = updates.end_hour !== undefined ? updates.end_hour : existing.end_hour;
    const em = updates.end_minute !== undefined ? updates.end_minute : existing.end_minute;
    const startMin = minutesOfDay(sh, sm);
    const endMin = minutesOfDay(eh, em);
    updates.cross_day = startMin >= endMin ? 1 : 0;
  }

  if (Object.keys(updates).length === 0) {
    return { success: true, shift: await getShiftById(id) };
  }

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const params = Object.values(updates);
  params.push(id);

  await run(`UPDATE duty_shifts SET ${sets} WHERE id = ?`, params);
  return { success: true, shift: await getShiftById(id) };
}

async function deleteShift(id) {
  const row = await get('SELECT * FROM duty_shifts WHERE id = ?', [id]);
  if (!row) return { success: false, error: '班次不存在', code: 404 };
  await run('DELETE FROM duty_shifts WHERE id = ?', [id]);
  return { success: true };
}

async function getCurrentShift() {
  const shifts = await all('SELECT * FROM duty_shifts WHERE enabled = 1');
  if (shifts.length === 0) return null;

  const now = Date.now();
  for (const shift of shifts) {
    if (shiftContainsTime(shift, now)) {
      return formatShift(shift);
    }
  }
  return null;
}

async function ensureCurrentLog() {
  const shift = await getCurrentShift();
  if (!shift) {
    return null;
  }

  const now = Date.now();
  const shiftDate = getShiftDate(shift, now);

  const existing = await get(
    'SELECT * FROM duty_logs WHERE shift_id = ? AND shift_date = ? AND status IN (?, ?)',
    [shift.id, shiftDate, 'active', 'locked']
  );

  if (existing) {
    shiftDutyStore.setCurrentLog(existing.id, shift.id, shift.name, shiftDate);
    return formatLog(existing);
  }

  const id = uuidv4();
  await run(
    'INSERT INTO duty_logs (id, shift_id, shift_name, shift_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, shift.id, shift.name, shiftDate, 'active', now]
  );

  shiftDutyStore.setCurrentLog(id, shift.id, shift.name, shiftDate);
  console.log(`[值班日志] 创建新班次日志: ${shift.name} (${shiftDate})`);
  return formatLog(await get('SELECT * FROM duty_logs WHERE id = ?', [id]));
}

async function addManualEntry(body) {
  const currentLog = shiftDutyStore.getCurrentLogId();
  if (!currentLog) {
    return { success: false, error: '没有当前活跃的值班日志', code: 400 };
  }

  const log = await get('SELECT * FROM duty_logs WHERE id = ?', [currentLog]);
  if (!log || log.status !== 'active') {
    return { success: false, error: '当前值班日志已锁定，不能添加条目', code: 400 };
  }

  if (!body.content || typeof body.content !== 'string' || body.content.trim() === '') {
    return { success: false, error: '条目内容不能为空', code: 400 };
  }
  if (body.level && !VALID_LEVELS.includes(body.level)) {
    return { success: false, error: '事件等级必须是normal/important/critical', code: 400 };
  }

  const id = uuidv4();
  const now = Date.now();

  await run(
    'INSERT INTO duty_log_entries (id, log_id, entry_type, content, device_id, level, editable, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, currentLog, 'manual', body.content.trim(), body.deviceId || null, body.level || 'normal', 1, now]
  );

  return { success: true, entry: formatEntry(await get('SELECT * FROM duty_log_entries WHERE id = ?', [id])) };
}

async function addSystemEvent(category, content, deviceId, sourceEventId, level) {
  const currentLog = shiftDutyStore.getCurrentLogId();
  if (!currentLog) return null;

  const log = await get('SELECT * FROM duty_logs WHERE id = ?', [currentLog]);
  if (!log || log.status !== 'active') return null;

  const id = uuidv4();
  const now = Date.now();

  await run(
    'INSERT INTO duty_log_entries (id, log_id, entry_type, content, device_id, level, event_category, source_event_id, editable, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, currentLog, 'system', content, deviceId || null, level || 'normal', category, sourceEventId || null, 0, now]
  );

  console.log(`[值班日志] 系统事件汇入: [${category}] ${content}`);
  return formatEntry(await get('SELECT * FROM duty_log_entries WHERE id = ?', [id]));
}

async function getLogEntries(logId) {
  const rows = await all(
    'SELECT * FROM duty_log_entries WHERE log_id = ? ORDER BY timestamp ASC',
    [logId]
  );
  return rows.map(formatEntry);
}

async function getCurrentLogWithEntries() {
  const currentLog = shiftDutyStore.getCurrentLogId();
  if (!currentLog) return null;

  const log = await get('SELECT * FROM duty_logs WHERE id = ?', [currentLog]);
  if (!log) return null;

  const entries = await getLogEntries(currentLog);
  const result = formatLog(log);
  result.entries = entries;
  return result;
}

async function initiateHandover(body) {
  if (!body.handoverPerson || typeof body.handoverPerson !== 'string') {
    return { success: false, error: '交班人姓名不能为空', code: 400 };
  }
  if (!body.receiverPerson || typeof body.receiverPerson !== 'string') {
    return { success: false, error: '接班人姓名不能为空', code: 400 };
  }

  const currentLog = shiftDutyStore.getCurrentLogId();
  if (!currentLog) {
    return { success: false, error: '没有当前活跃的值班日志', code: 400 };
  }

  const log = await get('SELECT * FROM duty_logs WHERE id = ?', [currentLog]);
  if (!log || log.status !== 'active') {
    return { success: false, error: '当前日志不是活跃状态，无法发起交接', code: 400 };
  }

  const id = uuidv4();
  const now = Date.now();

  await run(
    'INSERT INTO duty_handovers (id, log_id, handover_person, receiver_person, remarks, status, handover_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, currentLog, body.handoverPerson, body.receiverPerson, body.remarks || null, 'pending', now]
  );

  await run('UPDATE duty_logs SET status = ? WHERE id = ?', ['locked', currentLog]);

  console.log(`[值班日志] 交接班发起: ${body.handoverPerson} -> ${body.receiverPerson}`);

  return {
    success: true,
    handover: formatHandover(await get('SELECT * FROM duty_handovers WHERE id = ?', [id])),
    log: formatLog(await get('SELECT * FROM duty_logs WHERE id = ?', [currentLog]))
  };
}

async function confirmHandover(handoverId) {
  const handover = await get('SELECT * FROM duty_handovers WHERE id = ?', [handoverId]);
  if (!handover) {
    return { success: false, error: '交接记录不存在', code: 404 };
  }
  if (handover.status !== 'pending') {
    return { success: false, error: `交接状态为${handover.status}，无法确认`, code: 400 };
  }

  const now = Date.now();
  await run(
    'UPDATE duty_handovers SET status = ?, confirmed_at = ? WHERE id = ?',
    ['confirmed', now, handoverId]
  );

  await run(
    'UPDATE duty_logs SET status = ? WHERE id = ?',
    ['completed', handover.log_id]
  );

  shiftDutyStore.clearCurrentLog();

  const newLog = await ensureCurrentLog();

  console.log(`[值班日志] 交接班确认签收，已开启新班次日志`);

  return {
    success: true,
    handover: formatHandover(await get('SELECT * FROM duty_handovers WHERE id = ?', [handoverId])),
    newLog
  };
}

async function rejectHandover(handoverId, reason) {
  const handover = await get('SELECT * FROM duty_handovers WHERE id = ?', [handoverId]);
  if (!handover) {
    return { success: false, error: '交接记录不存在', code: 404 };
  }
  if (handover.status !== 'pending') {
    return { success: false, error: `交接状态为${handover.status}，无法拒绝`, code: 400 };
  }
  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    return { success: false, error: '拒绝签收必须填写原因', code: 400 };
  }

  const now = Date.now();
  await run(
    'UPDATE duty_handovers SET status = ?, reject_reason = ?, rejected_at = ? WHERE id = ?',
    ['rejected', reason.trim(), now, handoverId]
  );

  await run(
    'UPDATE duty_logs SET status = ? WHERE id = ?',
    ['active', handover.log_id]
  );

  shiftDutyStore.setCurrentLog(
    handover.log_id,
    shiftDutyStore.currentShiftId,
    shiftDutyStore.currentShiftName,
    shiftDutyStore.currentShiftDate
  );

  console.log(`[值班日志] 接班人拒绝签收: ${reason}`);

  return {
    success: true,
    handover: formatHandover(await get('SELECT * FROM duty_handovers WHERE id = ?', [handoverId])),
    log: formatLog(await get('SELECT * FROM duty_logs WHERE id = ?', [handover.log_id]))
  };
}

async function checkHandoverTimeout() {
  const shift = await getCurrentShift();
  if (!shift) return;

  const now = Date.now();
  const shiftDate = getShiftDate(shift, now);
  const shiftEnd = getShiftEndTimestamp(shift, shiftDate);
  const timeoutThreshold = shiftEnd + HANDOVER_TIMEOUT_MINUTES * 60 * 1000;

  if (now < timeoutThreshold) return;

  const currentLogId = shiftDutyStore.getCurrentLogId();
  if (!currentLogId) return;

  if (shiftDutyStore.hasTimeoutFlag(currentLogId)) return;

  const log = await get('SELECT * FROM duty_logs WHERE id = ? AND status = ?', [currentLogId, 'active']);
  if (!log) return;

  await addSystemEvent(
    'handover_timeout',
    `交接超时预警: 班次${shift.name}已结束超过${HANDOVER_TIMEOUT_MINUTES}分钟，尚未发起交接班`,
    null,
    null,
    'critical'
  );

  shiftDutyStore.setTimeoutFlag(currentLogId);
  console.log(`[值班日志] 交接超时预警: 班次${shift.name}已结束超过${HANDOVER_TIMEOUT_MINUTES}分钟`);
}

async function getLogById(id) {
  const row = await get('SELECT * FROM duty_logs WHERE id = ?', [id]);
  if (!row) return null;
  const result = formatLog(row);
  result.entries = await getLogEntries(id);

  const handover = await get('SELECT * FROM duty_handovers WHERE log_id = ? ORDER BY handover_at DESC LIMIT 1', [id]);
  if (handover) {
    result.handover = formatHandover(handover);
  }

  return result;
}

async function queryLogs(query) {
  let sql = 'SELECT * FROM duty_logs WHERE 1=1';
  const params = [];

  if (query.shiftDate) {
    sql += ' AND shift_date = ?';
    params.push(query.shiftDate);
  }
  if (query.shiftName) {
    sql += ' AND shift_name = ?';
    params.push(query.shiftName);
  }
  if (query.status) {
    sql += ' AND status = ?';
    params.push(query.status);
  }

  sql += ' ORDER BY created_at DESC';

  if (query.limit) {
    sql += ' LIMIT ?';
    params.push(Math.min(Math.max(parseInt(query.limit) || 100, 1), 1000));
  }

  const rows = await all(sql, params);
  const result = [];
  for (const row of rows) {
    const log = formatLog(row);
    log.entries = await getLogEntries(row.id);
    const handover = await get('SELECT * FROM duty_handovers WHERE log_id = ? ORDER BY handover_at DESC LIMIT 1', [row.id]);
    if (handover) {
      log.handover = formatHandover(handover);
    }
    result.push(log);
  }

  return result;
}

async function getStatistics(query) {
  let sql = 'SELECT * FROM duty_logs WHERE status = ?';
  const params = ['completed'];

  if (query.startDate) {
    sql += ' AND shift_date >= ?';
    params.push(query.startDate);
  }
  if (query.endDate) {
    sql += ' AND shift_date <= ?';
    params.push(query.endDate);
  }

  const logs = await all(sql, params);
  if (logs.length === 0) {
    return {
      totalLogs: 0,
      avgManualEntries: 0,
      avgSystemEvents: 0,
      avgHandoverTimeouts: 0,
      avgRejectCount: 0,
      byShift: {}
    };
  }

  const byShift = {};
  let totalManual = 0;
  let totalSystem = 0;
  let totalTimeouts = 0;
  let totalRejects = 0;

  for (const log of logs) {
    const entries = await all('SELECT * FROM duty_log_entries WHERE log_id = ?', [log.id]);
    const manualCount = entries.filter(e => e.entry_type === 'manual').length;
    const systemCount = entries.filter(e => e.entry_type === 'system').length;
    const timeoutCount = entries.filter(e => e.entry_type === 'system' && e.event_category === 'handover_timeout').length;

    const handovers = await all('SELECT * FROM duty_handovers WHERE log_id = ?', [log.id]);
    const rejectCount = handovers.filter(h => h.status === 'rejected').length;

    totalManual += manualCount;
    totalSystem += systemCount;
    totalTimeouts += timeoutCount;
    totalRejects += rejectCount;

    const name = log.shift_name;
    if (!byShift[name]) {
      byShift[name] = { count: 0, manualEntries: 0, systemEvents: 0, timeoutCount: 0, rejectCount: 0 };
    }
    byShift[name].count++;
    byShift[name].manualEntries += manualCount;
    byShift[name].systemEvents += systemCount;
    byShift[name].timeoutCount += timeoutCount;
    byShift[name].rejectCount += rejectCount;
  }

  const n = logs.length;
  const result = {
    totalLogs: n,
    avgManualEntries: +(totalManual / n).toFixed(2),
    avgSystemEvents: +(totalSystem / n).toFixed(2),
    avgHandoverTimeouts: +(totalTimeouts / n).toFixed(2),
    avgRejectCount: +(totalRejects / n).toFixed(2),
    byShift: {}
  };

  for (const [name, data] of Object.entries(byShift)) {
    result.byShift[name] = {
      count: data.count,
      avgManualEntries: +(data.manualEntries / data.count).toFixed(2),
      avgSystemEvents: +(data.systemEvents / data.count).toFixed(2),
      avgTimeoutCount: +(data.timeoutCount / data.count).toFixed(2),
      avgRejectCount: +(data.rejectCount / data.count).toFixed(2)
    };
  }

  return result;
}

async function getPendingHandover() {
  const currentLog = shiftDutyStore.getCurrentLogId();
  if (!currentLog) return null;

  const handover = await get(
    'SELECT * FROM duty_handovers WHERE log_id = ? AND status = ?',
    [currentLog, 'pending']
  );
  return handover ? formatHandover(handover) : null;
}

async function scanCycle() {
  try {
    const currentInfo = shiftDutyStore.getCurrentShiftInfo();
    const currentShift = await getCurrentShift();

    if (!currentShift) return;

    const now = Date.now();
    const newShiftDate = getShiftDate(currentShift, now);

    if (!currentInfo.logId || currentInfo.shiftId !== currentShift.id || currentInfo.shiftDate !== newShiftDate) {
      await ensureCurrentLog();
    }

    await checkHandoverTimeout();
  } catch (e) {
    console.error('[值班日志] 扫描周期错误:', e.message);
  }
}

function startEngine() {
  if (shiftDutyStore.scanTimer) return;

  ensureCurrentLog().catch(e => console.error('[值班日志] 初始化日志失败:', e.message));

  const timer = setInterval(() => {
    scanCycle().catch(e => console.error('[值班日志] 扫描错误:', e));
  }, SCAN_INTERVAL_MS);
  shiftDutyStore.setScanTimer(timer);

  console.log(`值班日志引擎已启动 (扫描间隔 ${SCAN_INTERVAL_MS}ms)`);
}

function stopEngine() {
  shiftDutyStore.clearAllTimers();
}

async function seedData() {
  const shiftCount = await get('SELECT COUNT(*) as cnt FROM duty_shifts');
  if (shiftCount.cnt > 0) return;

  const now = Date.now();

  const morningShift = await createShift({ name: '早班', startHour: 8, startMinute: 0, endHour: 16, endMinute: 0 });
  const afternoonShift = await createShift({ name: '中班', startHour: 16, startMinute: 0, endHour: 22, endMinute: 0 });
  const nightShift = await createShift({ name: '夜班', startHour: 22, startMinute: 0, endHour: 8, endMinute: 0, crossDay: true });
  console.log('[值班日志] 预置班次: 早班(08:00-16:00)、中班(16:00-22:00)、夜班(22:00-08:00)');

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const histLogId = uuidv4();
  const histCreatedAt = yesterday.getTime() + 8 * 3600 * 1000;
  await run(
    'INSERT INTO duty_logs (id, shift_id, shift_name, shift_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [histLogId, morningShift.shift.id, '早班', yesterdayStr, 'completed', histCreatedAt]
  );

  const histEntries = [
    { entryType: 'manual', content: '巡检1号泵站，运行正常，出口压力0.65MPa', deviceId: null, level: 'normal', eventCategory: null, sourceEventId: null, editable: 1, ts: histCreatedAt + 30 * 60 * 1000 },
    { entryType: 'system', content: '报警触发: 温控器当前温度超过阈值80°C(实测85.2°C)', deviceId: null, level: 'important', eventCategory: 'alarm', sourceEventId: 'alarm-1', editable: 0, ts: histCreatedAt + 90 * 60 * 1000 },
    { entryType: 'system', content: '联锁触发: 温度超限关加热(温控器当前温度>90°C)', deviceId: null, level: 'critical', eventCategory: 'interlock', sourceEventId: 'il-1', editable: 0, ts: histCreatedAt + 92 * 60 * 1000 },
    { entryType: 'system', content: '维保工单状态变更: 温控器紧急维保(scheduled -> in_progress)', deviceId: null, level: 'important', eventCategory: 'maintenance', sourceEventId: 'maint-1', editable: 0, ts: histCreatedAt + 120 * 60 * 1000 },
    { entryType: 'manual', content: '温控器异常处置：已切换至备用温控器，主温控器报修', deviceId: null, level: 'critical', eventCategory: null, sourceEventId: null, editable: 1, ts: histCreatedAt + 125 * 60 * 1000 },
    { entryType: 'system', content: '批次启动: BATCH-2025-001(产品A)', deviceId: null, level: 'normal', eventCategory: 'batch', sourceEventId: 'batch-1', editable: 0, ts: histCreatedAt + 150 * 60 * 1000 },
    { entryType: 'manual', content: '巡检液位计，液位3.2m正常，低液位报警阈值1.0m', deviceId: null, level: 'normal', eventCategory: null, sourceEventId: null, editable: 1, ts: histCreatedAt + 210 * 60 * 1000 },
    { entryType: 'system', content: '维保工单状态变更: 变频器计划维保(in_progress -> completed)', deviceId: null, level: 'normal', eventCategory: 'maintenance', sourceEventId: 'maint-2', editable: 0, ts: histCreatedAt + 270 * 60 * 1000 },
  ];

  for (const e of histEntries) {
    const entryId = uuidv4();
    await run(
      'INSERT INTO duty_log_entries (id, log_id, entry_type, content, device_id, level, event_category, source_event_id, editable, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [entryId, histLogId, e.entryType, e.content, e.deviceId, e.level, e.eventCategory, e.sourceEventId, e.editable, e.ts]
    );
  }

  const histHandoverId = uuidv4();
  const handoverAt = histCreatedAt + 7.5 * 3600 * 1000;
  const confirmedAt = histCreatedAt + 7.55 * 3600 * 1000;
  await run(
    'INSERT INTO duty_handovers (id, log_id, handover_person, receiver_person, remarks, status, handover_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [histHandoverId, histLogId, '张伟', '李明', '温控器异常已处置，备用机运行中，主温控器待维修', 'confirmed', handoverAt, confirmedAt]
  );

  console.log('[值班日志] 预置历史日志: 昨日早班(3条人工+5条系统事件, 已签收)');

  const currentShift = await getCurrentShift();
  if (currentShift) {
    const activeLog = await ensureCurrentLog();
    if (activeLog) {
      const activeLogId = activeLog.id;
      const sysEvents = [
        { content: '报警触发: 温控器当前温度超过阈值80°C(实测82.1°C)', level: 'important', eventCategory: 'alarm', sourceEventId: 'alarm-cur-1' },
        { content: '联锁触发: 液位低停泵(液位<1.0m)', level: 'critical', eventCategory: 'interlock', sourceEventId: 'il-cur-1' },
      ];

      for (const e of sysEvents) {
        const entryId = uuidv4();
        await run(
          'INSERT INTO duty_log_entries (id, log_id, entry_type, content, device_id, level, event_category, source_event_id, editable, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [entryId, activeLogId, 'system', e.content, null, e.level, e.eventCategory, e.sourceEventId, 0, Date.now() - 300000 + sysEvents.indexOf(e) * 60000]
        );
      }

      console.log('[值班日志] 预置当前班次活跃日志(2条系统事件)');
    }
  }
}

module.exports = {
  createShift,
  getShiftById,
  getAllShifts,
  updateShift,
  deleteShift,
  getCurrentShift,
  ensureCurrentLog,
  addManualEntry,
  addSystemEvent,
  getLogEntries,
  getCurrentLogWithEntries,
  initiateHandover,
  confirmHandover,
  rejectHandover,
  getLogById,
  queryLogs,
  getStatistics,
  getPendingHandover,
  startEngine,
  stopEngine,
  seedData,
  VALID_LEVELS,
  VALID_EVENT_CATEGORIES
};
