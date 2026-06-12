const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const energyStore = require('../store/energyStore');
const notificationService = require('./notificationService');
const maintenanceService = require('./maintenanceService');

function minutesOfDay(hour, minute) {
  return hour * 60 + minute;
}

function shiftContainsTime(shift, ts) {
  const d = new Date(ts);
  const curMin = minutesOfDay(d.getHours(), d.getMinutes());
  const startMin = minutesOfDay(shift.startHour !== undefined ? shift.startHour : shift.start_hour, shift.startMinute !== undefined ? shift.startMinute : shift.start_minute);
  const endMin = minutesOfDay(shift.endHour !== undefined ? shift.endHour : shift.end_hour, shift.endMinute !== undefined ? shift.endMinute : shift.end_minute);
  const crossDay = shift.crossDay !== undefined ? shift.crossDay : shift.cross_day;

  if (!crossDay) {
    return curMin >= startMin && curMin < endMin;
  } else {
    return curMin >= startMin || curMin < endMin;
  }
}

function getShiftDate(shift, ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  const crossDay = shift.crossDay !== undefined ? shift.crossDay : shift.cross_day;
  if (!crossDay) {
    return `${y}-${m}-${day}`;
  }

  const curMin = minutesOfDay(d.getHours(), d.getMinutes());
  const startMin = minutesOfDay(shift.startHour !== undefined ? shift.startHour : shift.start_hour, shift.startMinute !== undefined ? shift.startMinute : shift.start_minute);

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

function getShiftStartTimestamp(shift, shiftDate) {
  const [y, m, d] = shiftDate.split('-').map(Number);
  const sh = shift.startHour !== undefined ? shift.startHour : shift.start_hour;
  const sm = shift.startMinute !== undefined ? shift.startMinute : shift.start_minute;
  const dt = new Date(y, m - 1, d, sh, sm, 0, 0);
  return dt.getTime();
}

function getShiftEndTimestamp(shift, shiftDate) {
  const [y, m, d] = shiftDate.split('-').map(Number);
  const eh = shift.endHour !== undefined ? shift.endHour : shift.end_hour;
  const em = shift.endMinute !== undefined ? shift.endMinute : shift.end_minute;
  const crossDay = shift.crossDay !== undefined ? shift.crossDay : shift.cross_day;
  const dt = new Date(y, m - 1, d, eh, em, 0, 0);
  if (crossDay) {
    dt.setDate(dt.getDate() + 1);
  }
  return dt.getTime();
}

function validateShift(body) {
  if (!body.name) return '缺少班次名称';
  if (typeof body.startHour !== 'number' || body.startHour < 0 || body.startHour > 23) {
    return 'startHour必须是0-23之间的整数';
  }
  if (typeof body.startMinute !== 'number' || body.startMinute < 0 || body.startMinute > 59) {
    return 'startMinute必须是0-59之间的整数';
  }
  if (typeof body.endHour !== 'number' || body.endHour < 0 || body.endHour > 23) {
    return 'endHour必须是0-23之间的整数';
  }
  if (typeof body.endMinute !== 'number' || body.endMinute < 0 || body.endMinute > 59) {
    return 'endMinute必须是0-59之间的整数';
  }
  return null;
}

function formatShift(row) {
  return {
    id: row.id,
    name: row.name,
    startHour: row.start_hour,
    startMinute: row.start_minute,
    endHour: row.end_hour,
    endMinute: row.end_minute,
    crossDay: !!row.cross_day,
    enabled: !!row.enabled,
    createdAt: row.created_at
  };
}

async function createShift(body) {
  const err = validateShift(body);
  if (err) return { success: false, error: err };

  const startMin = minutesOfDay(body.startHour, body.startMinute);
  const endMin = minutesOfDay(body.endHour, body.endMinute);
  const crossDay = endMin <= startMin ? 1 : 0;

  const id = uuidv4();
  await run(
    `INSERT INTO work_shifts (id, name, start_hour, start_minute, end_hour, end_minute, cross_day, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [id, body.name, body.startHour, body.startMinute, body.endHour, body.endMinute, crossDay, Date.now()]
  );

  return { success: true, shift: await getShiftById(id) };
}

async function updateShift(id, body) {
  const existing = await get('SELECT * FROM work_shifts WHERE id = ?', [id]);
  if (!existing) return { success: false, error: '班次不存在' };

  const merged = {
    name: existing.name,
    startHour: existing.start_hour,
    startMinute: existing.start_minute,
    endHour: existing.end_hour,
    endMinute: existing.end_minute,
    ...body
  };

  const err = validateShift(merged);
  if (err) return { success: false, error: err };

  const startMin = minutesOfDay(merged.startHour, merged.startMinute);
  const endMin = minutesOfDay(merged.endHour, merged.endMinute);
  const crossDay = endMin <= startMin ? 1 : 0;

  await run(
    `UPDATE work_shifts SET name=?, start_hour=?, start_minute=?, end_hour=?, end_minute=?, cross_day=?, enabled=? WHERE id=?`,
    [
      merged.name,
      merged.startHour,
      merged.startMinute,
      merged.endHour,
      merged.endMinute,
      crossDay,
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
      id
    ]
  );

  return { success: true, shift: await getShiftById(id) };
}

async function deleteShift(id) {
  const existing = await get('SELECT * FROM work_shifts WHERE id = ?', [id]);
  if (!existing) return { success: false, error: '班次不存在' };
  await run('DELETE FROM work_shifts WHERE id = ?', [id]);
  return { success: true };
}

async function getShiftById(id) {
  const row = await get('SELECT * FROM work_shifts WHERE id = ?', [id]);
  return row ? formatShift(row) : null;
}

async function getAllShifts() {
  const rows = await all('SELECT * FROM work_shifts ORDER BY start_hour, start_minute');
  return rows.map(formatShift);
}

function validateBinding(body) {
  if (!body.deviceId) return '缺少deviceId';
  if (body.powerRegAddress === undefined) return '缺少powerRegAddress';
  if (!deviceStore.hasDevice(body.deviceId)) return '设备不存在';
  if (body.ratedPower !== undefined && typeof body.ratedPower !== 'number') {
    return 'ratedPower必须是数字';
  }
  if (body.loadThreshold !== undefined && typeof body.loadThreshold !== 'number') {
    return 'loadThreshold必须是数字';
  }
  if (body.thresholdKwh !== undefined && typeof body.thresholdKwh !== 'number') {
    return 'thresholdKwh必须是数字';
  }
  return null;
}

function formatBinding(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    powerRegAddress: row.power_reg_address,
    ratedPower: row.rated_power,
    loadThreshold: row.load_threshold,
    thresholdKwh: row.threshold_kwh,
    enabled: !!row.enabled,
    createdAt: row.created_at
  };
}

async function createBinding(body) {
  const err = validateBinding(body);
  if (err) return { success: false, error: err };

  const id = uuidv4();
  try {
    await run(
      `INSERT INTO energy_bindings (id, device_id, power_reg_address, rated_power, load_threshold, threshold_kwh, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        id,
        body.deviceId,
        body.powerRegAddress,
        body.ratedPower || 0,
        body.loadThreshold || 0,
        body.thresholdKwh !== undefined ? body.thresholdKwh : null,
        Date.now()
      ]
    );
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return { success: false, error: '该设备的此寄存器已绑定' };
    }
    throw e;
  }

  return { success: true, binding: await getBindingById(id) };
}

async function updateBinding(id, body) {
  const existing = await get('SELECT * FROM energy_bindings WHERE id = ?', [id]);
  if (!existing) return { success: false, error: '绑定不存在' };

  const merged = {
    deviceId: existing.device_id,
    powerRegAddress: existing.power_reg_address,
    ratedPower: existing.rated_power,
    loadThreshold: existing.load_threshold,
    thresholdKwh: existing.threshold_kwh,
    ...body
  };

  const err = validateBinding(merged);
  if (err) return { success: false, error: err };

  await run(
    `UPDATE energy_bindings SET rated_power=?, load_threshold=?, threshold_kwh=?, enabled=? WHERE id=?`,
    [
      merged.ratedPower,
      merged.loadThreshold,
      merged.thresholdKwh !== undefined ? merged.thresholdKwh : null,
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
      id
    ]
  );

  return { success: true, binding: await getBindingById(id) };
}

async function deleteBinding(id) {
  const existing = await get('SELECT * FROM energy_bindings WHERE id = ?', [id]);
  if (!existing) return { success: false, error: '绑定不存在' };
  await run('DELETE FROM energy_bindings WHERE id = ?', [id]);
  return { success: true };
}

async function getBindingById(id) {
  const row = await get('SELECT * FROM energy_bindings WHERE id = ?', [id]);
  return row ? formatBinding(row) : null;
}

async function getAllBindings() {
  const rows = await all('SELECT * FROM energy_bindings ORDER BY created_at');
  return rows.map(formatBinding);
}

async function getBindingsByDevice(deviceId) {
  const rows = await all('SELECT * FROM energy_bindings WHERE device_id = ? ORDER BY created_at', [deviceId]);
  return rows.map(formatBinding);
}

function formatStat(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    shiftId: row.shift_id,
    shiftDate: row.shift_date,
    energyKwh: row.energy_kwh,
    runtimeSeconds: row.runtime_seconds,
    avgLoadRate: row.avg_load_rate,
    peakPower: row.peak_power,
    sampleCount: row.sample_count,
    startTime: row.start_time,
    endTime: row.end_time,
    completed: !!row.completed,
    shiftName: row.shift_name,
    deviceName: row.device_name
  };
}

async function getOrCreateCurrentStat(deviceId, binding, shift, now) {
  const shiftDate = getShiftDate(shift, now);
  const shiftStart = getShiftStartTimestamp(shift, shiftDate);

  let row = await get(
    `SELECT s.*, ws.name as shift_name, d.name as device_name
     FROM shift_energy_stats s
     JOIN work_shifts ws ON s.shift_id = ws.id
     JOIN devices d ON s.device_id = d.id
     WHERE s.device_id = ? AND s.shift_id = ? AND s.shift_date = ?`,
    [deviceId, shift.id, shiftDate]
  );

  if (!row) {
    await run(
      `INSERT INTO shift_energy_stats (device_id, shift_id, shift_date, energy_kwh, runtime_seconds, avg_load_rate, peak_power, sample_count, start_time, end_time, completed)
       VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?, NULL, 0)`,
      [deviceId, shift.id, shiftDate, shiftStart]
    );
    row = await get(
      `SELECT s.*, ws.name as shift_name, d.name as device_name
       FROM shift_energy_stats s
       JOIN work_shifts ws ON s.shift_id = ws.id
       JOIN devices d ON s.device_id = d.id
       WHERE s.device_id = ? AND s.shift_id = ? AND s.shift_date = ?`,
      [deviceId, shift.id, shiftDate]
    );
  }

  return row;
}

async function finalizeExpiredShifts(now) {
  const shifts = await getAllShifts();
  const bindings = await getAllBindings();

  for (const shift of shifts) {
    if (!shift.enabled) continue;
    for (const binding of bindings) {
      if (!binding.enabled) continue;

      const stats = await all(
        `SELECT * FROM shift_energy_stats WHERE device_id = ? AND shift_id = ? AND completed = 0`,
        [binding.deviceId, shift.id]
      );

      for (const stat of stats) {
        const shiftEnd = getShiftEndTimestamp(shift, stat.shift_date);
        if (now >= shiftEnd) {
          await run(
            `UPDATE shift_energy_stats SET end_time = ?, completed = 1 WHERE id = ?`,
            [shiftEnd, stat.id]
          );
        }
      }
    }
  }
}

async function checkAndTriggerEnergyAlarm(binding, shift, stat, now) {
  if (!binding.threshold_kwh) return;
  if (stat.energy_kwh <= binding.threshold_kwh) return;

  const existing = await get(
    `SELECT * FROM energy_alarms WHERE device_id = ? AND shift_id = ? AND shift_date = ?`,
    [binding.device_id, shift.id, stat.shift_date]
  );
  if (existing) return;

  await run(
    `INSERT INTO energy_alarms (device_id, shift_id, shift_date, binding_id, energy_kwh, threshold_kwh, triggered_at, acknowledged, acknowledged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
    [
      binding.device_id,
      shift.id,
      stat.shift_date,
      binding.id,
      stat.energy_kwh,
      binding.threshold_kwh,
      now
    ]
  );

  const deviceRow = await get('SELECT name FROM devices WHERE id = ?', [binding.device_id]);
  const deviceName = deviceRow ? deviceRow.name : binding.device_id;

  console.log(
    `[能耗预警] 设备[${deviceName}] 班次[${shift.name}(${stat.shift_date})] 当前能耗 ${stat.energy_kwh.toFixed(3)} kWh 超过阈值 ${binding.threshold_kwh} kWh`
  );
}

async function sampleEnergyForBinding(binding, now) {
  const shifts = await getAllShifts();
  const activeShifts = shifts.filter(s => s.enabled && shiftContainsTime(s, now));
  const deviceId = binding.deviceId !== undefined ? binding.deviceId : binding.device_id;
  const powerRegAddress = binding.powerRegAddress !== undefined ? binding.powerRegAddress : binding.power_reg_address;
  const ratedPower = binding.ratedPower !== undefined ? binding.ratedPower : binding.rated_power;
  const loadThreshold = binding.loadThreshold !== undefined ? binding.loadThreshold : binding.load_threshold;
  const thresholdKwh = binding.thresholdKwh !== undefined ? binding.thresholdKwh : binding.threshold_kwh;

  if (activeShifts.length === 0) return;

  if (maintenanceService.isDeviceLocked(deviceId)) {
    return;
  }

  const regRow = await get(
    `SELECT * FROM registers WHERE device_id = ? AND address = ?`,
    [deviceId, powerRegAddress]
  );
  if (!regRow) return;

  const { value: rawPower, stale } = deviceStore.getRegisterValue(
    deviceId,
    powerRegAddress,
    regRow.data_type
  );
  if (stale) return;

  const powerKw = Math.max(0, rawPower);
  const rPower = ratedPower || powerKw || 1;
  const loadRate = rPower > 0 ? (powerKw / rPower) : 0;

  const lastTs = energyStore.getLastSample(deviceId);
  const deltaHours = lastTs ? Math.max(0, (now - lastTs) / 3600000) : 0;
  const lastPower = energyStore.getLastPower(deviceId, powerRegAddress);
  const avgPower = lastPower !== null ? (lastPower + powerKw) / 2 : powerKw;
  const deltaKwh = deltaHours * avgPower;
  const deltaRuntimeSec = loadRate > (loadThreshold || 0.05) ? (deltaHours * 3600) : 0;

  for (const shift of activeShifts) {
    const stat = await getOrCreateCurrentStat(deviceId, binding, shift, now);
    if (!stat) continue;

    const newEnergy = stat.energy_kwh + deltaKwh;
    const newRuntime = stat.runtime_seconds + deltaRuntimeSec;
    const newSampleCount = stat.sample_count + 1;
    const newAvgLoad = (stat.avg_load_rate * stat.sample_count + loadRate) / newSampleCount;
    const newPeak = Math.max(stat.peak_power, powerKw);

    await run(
      `UPDATE shift_energy_stats SET energy_kwh=?, runtime_seconds=?, avg_load_rate=?, peak_power=?, sample_count=? WHERE id=?`,
      [newEnergy, newRuntime, newAvgLoad, newPeak, newSampleCount, stat.id]
    );

    const updatedStat = {
      ...stat,
      energy_kwh: newEnergy,
      runtime_seconds: newRuntime,
      avg_load_rate: newAvgLoad,
      peak_power: newPeak,
      sample_count: newSampleCount
    };

    if (thresholdKwh !== undefined && thresholdKwh !== null) {
      const bindingCompat = { ...binding, device_id: deviceId, threshold_kwh: thresholdKwh };
      await checkAndTriggerEnergyAlarm(bindingCompat, shift, updatedStat, now);
    }
  }

  energyStore.setLastSample(deviceId, now);
  energyStore.setLastPower(deviceId, powerRegAddress, powerKw);
}

async function sampleAllEnergy() {
  const now = Date.now();
  await finalizeExpiredShifts(now);

  const bindings = await getAllBindings();
  for (const binding of bindings) {
    if (!binding.enabled) continue;
    await sampleEnergyForBinding(binding, now);
  }
}

function startEngine() {
  if (energyStore.timer) return;
  const timer = setInterval(sampleAllEnergy, energyStore.intervalMs);
  energyStore.setTimer(timer);
  console.log('能耗计量引擎已启动，采样间隔 10s');
}

function stopEngine() {
  energyStore.clearTimer();
  console.log('能耗计量引擎已停止');
}

async function getShiftStats(query = {}) {
  let sql = `
    SELECT s.*, ws.name as shift_name, d.name as device_name
    FROM shift_energy_stats s
    JOIN work_shifts ws ON s.shift_id = ws.id
    JOIN devices d ON s.device_id = d.id
    WHERE 1=1
  `;
  const params = [];

  if (query.deviceId) {
    sql += ' AND s.device_id = ?';
    params.push(query.deviceId);
  }
  if (query.shiftId) {
    sql += ' AND s.shift_id = ?';
    params.push(query.shiftId);
  }
  if (query.shiftDate) {
    sql += ' AND s.shift_date = ?';
    params.push(query.shiftDate);
  }
  if (query.startDate) {
    sql += ' AND s.shift_date >= ?';
    params.push(query.startDate);
  }
  if (query.endDate) {
    sql += ' AND s.shift_date <= ?';
    params.push(query.endDate);
  }
  sql += ' ORDER BY s.shift_date DESC, s.start_time DESC';

  const rows = await all(sql, params);
  return rows.map(formatStat);
}

async function compareTwoDates(dateA, dateB, deviceId) {
  let sqlA = `
    SELECT s.*, ws.name as shift_name, d.name as device_name
    FROM shift_energy_stats s
    JOIN work_shifts ws ON s.shift_id = ws.id
    JOIN devices d ON s.device_id = d.id
    WHERE s.shift_date = ?
  `;
  let sqlB = `
    SELECT s.*, ws.name as shift_name, d.name as device_name
    FROM shift_energy_stats s
    JOIN work_shifts ws ON s.shift_id = ws.id
    JOIN devices d ON s.device_id = d.id
    WHERE s.shift_date = ?
  `;
  const paramsA = [dateA];
  const paramsB = [dateB];

  if (deviceId) {
    sqlA += ' AND s.device_id = ?';
    sqlB += ' AND s.device_id = ?';
    paramsA.push(deviceId);
    paramsB.push(deviceId);
  }

  const [rowsA, rowsB] = await Promise.all([all(sqlA, paramsA), all(sqlB, paramsB)]);

  const statsA = rowsA.map(formatStat);
  const statsB = rowsB.map(formatStat);

  const comparisons = [];
  const mapA = new Map();
  for (const s of statsA) {
    mapA.set(`${s.deviceId}_${s.shiftId}`, s);
  }
  for (const sB of statsB) {
    const sA = mapA.get(`${sB.deviceId}_${sB.shiftId}`);
    const energyDiff = sA ? (sB.energyKwh - sA.energyKwh) : sB.energyKwh;
    const energyPct = sA && sA.energyKwh > 0 ? ((energyDiff / sA.energyKwh) * 100) : null;
    comparisons.push({
      deviceId: sB.deviceId,
      deviceName: sB.deviceName,
      shiftId: sB.shiftId,
      shiftName: sB.shiftName,
      dateA: dateA,
      dateB: dateB,
      energyA: sA ? sA.energyKwh : 0,
      energyB: sB.energyKwh,
      energyDiff: energyDiff,
      energyDiffPct: energyPct,
      runtimeA: sA ? sA.runtimeSeconds : 0,
      runtimeB: sB.runtimeSeconds,
      loadRateA: sA ? sA.avgLoadRate : 0,
      loadRateB: sB.avgLoadRate
    });
    if (sA) mapA.delete(`${sB.deviceId}_${sB.shiftId}`);
  }
  for (const sA of mapA.values()) {
    comparisons.push({
      deviceId: sA.deviceId,
      deviceName: sA.deviceName,
      shiftId: sA.shiftId,
      shiftName: sA.shiftName,
      dateA: dateA,
      dateB: dateB,
      energyA: sA.energyKwh,
      energyB: 0,
      energyDiff: -sA.energyKwh,
      energyDiffPct: sA.energyKwh > 0 ? -100 : null,
      runtimeA: sA.runtimeSeconds,
      runtimeB: 0,
      loadRateA: sA.avgLoadRate,
      loadRateB: 0
    });
  }

  return {
    dateA,
    dateB,
    deviceId: deviceId || null,
    totalEnergyA: statsA.reduce((s, r) => s + r.energyKwh, 0),
    totalEnergyB: statsB.reduce((s, r) => s + r.energyKwh, 0),
    comparisons
  };
}

function formatEnergyAlarm(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    shiftId: row.shift_id,
    shiftName: row.shift_name,
    shiftDate: row.shift_date,
    bindingId: row.binding_id,
    energyKwh: row.energy_kwh,
    thresholdKwh: row.threshold_kwh,
    triggeredAt: row.triggered_at,
    acknowledged: !!row.acknowledged,
    acknowledgedAt: row.acknowledged_at
  };
}

async function getEnergyAlarms(query = {}) {
  let sql = `
    SELECT a.*, d.name as device_name, ws.name as shift_name
    FROM energy_alarms a
    JOIN devices d ON a.device_id = d.id
    JOIN work_shifts ws ON a.shift_id = ws.id
    WHERE 1=1
  `;
  const params = [];

  if (query.deviceId) {
    sql += ' AND a.device_id = ?';
    params.push(query.deviceId);
  }
  if (query.acknowledged !== undefined) {
    sql += ' AND a.acknowledged = ?';
    params.push(query.acknowledged ? 1 : 0);
  }
  if (query.shiftDate) {
    sql += ' AND a.shift_date = ?';
    params.push(query.shiftDate);
  }
  sql += ' ORDER BY a.triggered_at DESC';

  const rows = await all(sql, params);
  return rows.map(formatEnergyAlarm);
}

async function acknowledgeEnergyAlarm(id) {
  const row = await get('SELECT * FROM energy_alarms WHERE id = ?', [id]);
  if (!row) return { success: false, error: '预警不存在' };
  if (row.acknowledged) return { success: true, alreadyAcknowledged: true };

  await run('UPDATE energy_alarms SET acknowledged = 1, acknowledged_at = ? WHERE id = ?',
    [Date.now(), id]);
  return { success: true };
}

module.exports = {
  createShift,
  updateShift,
  deleteShift,
  getShiftById,
  getAllShifts,
  createBinding,
  updateBinding,
  deleteBinding,
  getBindingById,
  getAllBindings,
  getBindingsByDevice,
  startEngine,
  stopEngine,
  sampleAllEnergy,
  getShiftStats,
  compareTwoDates,
  getEnergyAlarms,
  acknowledgeEnergyAlarm,
  shiftContainsTime,
  getShiftDate,
  getShiftStartTimestamp,
  getShiftEndTimestamp
};
