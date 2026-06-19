const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const modeStore = require('../store/modeStore');
const maintenanceService = require('./maintenanceService');
const { evaluateExpression, parseExpression } = require('../utils/expression');

function validateModeInput(body) {
  if (!body.deviceId) return '缺少deviceId';
  if (!deviceStore.hasDevice(body.deviceId)) return '设备不存在';
  if (!body.name || typeof body.name !== 'string') return '模式名称不能为空';

  if (body.precondition !== undefined && body.precondition !== null && body.precondition !== '') {
    try {
      parseExpression(body.precondition);
    } catch (e) {
      return '前置条件表达式解析失败: ' + e.message;
    }
  }

  if (body.registers !== undefined) {
    if (!Array.isArray(body.registers)) return 'registers必须是数组';
    for (const reg of body.registers) {
      if (typeof reg.address !== 'number') return '寄存器地址必须是数字';
      if (typeof reg.value !== 'number') return '寄存器值必须是数字';
    }
  }

  if (body.alarmOverrides !== undefined) {
    if (!Array.isArray(body.alarmOverrides)) return 'alarmOverrides必须是数组';
    for (const ov of body.alarmOverrides) {
      if (!ov.alarmRuleId || typeof ov.alarmRuleId !== 'string') return '每个报警阈值覆盖必须指定alarmRuleId';
      if (typeof ov.newThreshold !== 'number') return 'newThreshold必须是数字';
    }
  }

  return null;
}

async function createMode(body) {
  const err = validateModeInput(body);
  if (err) return { success: false, error: err };

  const id = uuidv4();
  const now = Date.now();
  const precondition = body.precondition || null;

  await run(
    'INSERT INTO device_modes (id, device_id, name, precondition, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, body.deviceId, body.name, precondition, now]
  );

  const registers = body.registers || [];
  for (const reg of registers) {
    await run(
      'INSERT INTO device_mode_registers (mode_id, device_id, address, value) VALUES (?, ?, ?, ?)',
      [id, body.deviceId, reg.address, reg.value]
    );
  }

  const alarmOverrides = body.alarmOverrides || [];
  for (const ov of alarmOverrides) {
    await run(
      'INSERT INTO device_mode_alarm_overrides (mode_id, alarm_rule_id, new_threshold) VALUES (?, ?, ?)',
      [id, ov.alarmRuleId, ov.newThreshold]
    );
  }

  modeStore.addMode(id, body.deviceId, body.name, precondition);
  modeStore.setModeRegisters(id, registers.map(r => ({ address: r.address, value: r.value })));
  modeStore.setModeAlarmOverrides(id, alarmOverrides.map(o => ({ alarmRuleId: o.alarmRuleId, newThreshold: o.newThreshold })));

  return { success: true, mode: await getModeById(id) };
}

async function getModeById(id) {
  const row = await get('SELECT * FROM device_modes WHERE id = ?', [id]);
  if (!row) return null;

  const registers = await all('SELECT address, value FROM device_mode_registers WHERE mode_id = ?', [id]);
  const overrides = await all('SELECT alarm_rule_id, new_threshold FROM device_mode_alarm_overrides WHERE mode_id = ?', [id]);

  return {
    id: row.id,
    deviceId: row.device_id,
    name: row.name,
    precondition: row.precondition,
    registers: registers.map(r => ({ address: r.address, value: r.value })),
    alarmOverrides: overrides.map(o => ({ alarmRuleId: o.alarm_rule_id, newThreshold: o.new_threshold })),
    createdAt: row.created_at
  };
}

async function getModesByDevice(deviceId) {
  const rows = await all('SELECT * FROM device_modes WHERE device_id = ? ORDER BY created_at', [deviceId]);
  const result = [];
  for (const row of rows) {
    const registers = await all('SELECT address, value FROM device_mode_registers WHERE mode_id = ?', [row.id]);
    const overrides = await all('SELECT alarm_rule_id, new_threshold FROM device_mode_alarm_overrides WHERE mode_id = ?', [row.id]);
    result.push({
      id: row.id,
      deviceId: row.device_id,
      name: row.name,
      precondition: row.precondition,
      registers: registers.map(r => ({ address: r.address, value: r.value })),
      alarmOverrides: overrides.map(o => ({ alarmRuleId: o.alarm_rule_id, newThreshold: o.new_threshold })),
      createdAt: row.created_at
    });
  }
  return result;
}

async function deleteMode(id) {
  const row = await get('SELECT * FROM device_modes WHERE id = ?', [id]);
  if (!row) return { success: false, error: '模式不存在' };

  const activeMode = modeStore.getActiveMode(row.device_id);
  if (activeMode && activeMode.modeId === id) {
    return { success: false, error: '无法删除当前激活的模式，请先退出该模式' };
  }

  await run('DELETE FROM device_mode_alarm_overrides WHERE mode_id = ?', [id]);
  await run('DELETE FROM device_mode_registers WHERE mode_id = ?', [id]);
  await run('DELETE FROM device_modes WHERE id = ?', [id]);

  modeStore.removeMode(id);
  return { success: true };
}

function resolveRegisterReference(refName) {
  const parts = refName.split('.');
  if (parts.length < 2) return 0;
  const deviceId = parts[0];
  const regStr = parts[1];
  const addrMatch = regStr.match(/^reg(\d+)$/);
  if (!addrMatch) return 0;
  const address = parseInt(addrMatch[1]);
  const { value } = deviceStore.getRegisterValue(deviceId, address, 'float32');
  return value;
}

async function checkPrecondition(modeId) {
  const mode = modeStore.getMode(modeId);
  if (!mode) return { satisfied: false, error: '模式不存在' };
  if (!mode.precondition) return { satisfied: true };

  try {
    const result = evaluateExpression(mode.precondition, resolveRegisterReference);
    const satisfied = result !== 0;
    return { satisfied, evalResult: result };
  } catch (e) {
    return { satisfied: false, error: '前置条件求值失败: ' + e.message };
  }
}

async function saveModeState(deviceId, modeId, savedRegisterValues, savedAlarmThresholds, enteredAt) {
  await run(
    `INSERT OR REPLACE INTO device_mode_state (device_id, mode_id, saved_register_values, saved_alarm_thresholds, entered_at) VALUES (?, ?, ?, ?, ?)`,
    [deviceId, modeId, JSON.stringify(savedRegisterValues), JSON.stringify(savedAlarmThresholds), enteredAt]
  );
}

async function deleteModeState(deviceId) {
  await run('DELETE FROM device_mode_state WHERE device_id = ?', [deviceId]);
}

async function switchMode(deviceId, modeId, operator = 'system') {
  if (!deviceStore.hasDevice(deviceId)) {
    return { success: false, error: '设备不存在' };
  }

  const targetMode = modeStore.getMode(modeId);
  if (!targetMode || targetMode.deviceId !== deviceId) {
    return { success: false, error: '模式不存在或不属于该设备' };
  }

  const currentActive = modeStore.getActiveMode(deviceId);
  if (currentActive && currentActive.modeId === modeId) {
    return { success: false, error: '设备已处于该模式' };
  }

  if (maintenanceService.isDeviceLocked(deviceId)) {
    return { success: false, error: '设备维保中，无法切换模式' };
  }

  const preconditionResult = await checkPrecondition(modeId);
  if (!preconditionResult.satisfied) {
    const errorMsg = preconditionResult.error || `前置条件不满足(求值结果: ${preconditionResult.evalResult})`;
    await logHistory(deviceId, currentActive, targetMode, operator, 'failed', errorMsg);
    return { success: false, error: '前置条件不满足: ' + errorMsg };
  }

  const modeRegisters = modeStore.getModeRegisters(modeId);
  const modeAlarmOverrides = modeStore.getModeAlarmOverrides(modeId);

  const savedRegisterValues = [];
  for (const reg of modeRegisters) {
    const regRow = await get('SELECT data_type FROM registers WHERE device_id = ? AND address = ?', [deviceId, reg.address]);
    if (!regRow) {
      const errorMsg = `寄存器不存在: 设备${deviceId}地址${reg.address}`;
      await logHistory(deviceId, currentActive, targetMode, operator, 'failed', errorMsg);
      return { success: false, error: errorMsg };
    }
    const { value } = deviceStore.getRegisterValue(deviceId, reg.address, regRow.data_type);
    savedRegisterValues.push({ address: reg.address, value, dataType: regRow.data_type });
  }

  const savedAlarmThresholds = [];
  for (const ov of modeAlarmOverrides) {
    const rule = await get('SELECT threshold FROM alarm_rules WHERE id = ?', [ov.alarmRuleId]);
    if (!rule) {
      const errorMsg = `报警规则不存在: ${ov.alarmRuleId}`;
      await logHistory(deviceId, currentActive, targetMode, operator, 'failed', errorMsg);
      return { success: false, error: errorMsg };
    }
    savedAlarmThresholds.push({ alarmRuleId: ov.alarmRuleId, originalThreshold: rule.threshold });
  }

  const previousRegisterValues = currentActive ? currentActive.savedRegisterValues : null;
  const previousAlarmThresholds = currentActive ? currentActive.savedAlarmThresholds : null;

  if (currentActive) {
    await restoreAlarmThresholds(currentActive.savedAlarmThresholds);
  }

  const writtenRegisters = [];
  for (const reg of modeRegisters) {
    const regRow = await get('SELECT data_type FROM registers WHERE device_id = ? AND address = ?', [deviceId, reg.address]);
    if (!regRow) {
      await rollbackRegisters(deviceId, writtenRegisters);
      if (previousAlarmThresholds) {
        await applyAlarmThresholds(previousAlarmThresholds);
      }
      await restoreAlarmThresholds(savedAlarmThresholds);
      const errorMsg = `寄存器不存在: 地址${reg.address}`;
      await logHistory(deviceId, currentActive, targetMode, operator, 'failed', errorMsg);
      return { success: false, error: errorMsg, rolledBack: true };
    }

    if (maintenanceService.isDeviceLocked(deviceId)) {
      await rollbackRegisters(deviceId, writtenRegisters);
      if (previousAlarmThresholds) {
        await applyAlarmThresholds(previousAlarmThresholds);
      }
      await restoreAlarmThresholds(savedAlarmThresholds);
      await logHistory(deviceId, currentActive, targetMode, operator, 'failed', '设备维保中');
      return { success: false, error: '设备维保中，写入寄存器失败', rolledBack: true };
    }

    const status = deviceStore.getStatus(deviceId);
    if (status === 'offline' || status === 'fault') {
      await rollbackRegisters(deviceId, writtenRegisters);
      if (previousAlarmThresholds) {
        await applyAlarmThresholds(previousAlarmThresholds);
      }
      await restoreAlarmThresholds(savedAlarmThresholds);
      const errorMsg = `设备离线或故障(状态: ${status})`;
      await logHistory(deviceId, currentActive, targetMode, operator, 'failed', errorMsg);
      return { success: false, error: errorMsg, rolledBack: true };
    }

    deviceStore.setRegisterValue(deviceId, reg.address, regRow.data_type, reg.value);
    writtenRegisters.push({ address: reg.address, originalValue: savedRegisterValues.find(s => s.address === reg.address)?.value, value: reg.value, dataType: regRow.data_type });
  }

  const appliedOverrides = [];
  for (const ov of modeAlarmOverrides) {
    await run('UPDATE alarm_rules SET threshold = ? WHERE id = ?', [ov.newThreshold, ov.alarmRuleId]);
    appliedOverrides.push(ov);
  }

  const enteredAt = Date.now();
  modeStore.setActiveMode(deviceId, modeId, modeRegisters, savedRegisterValues, savedAlarmThresholds);

  await saveModeState(deviceId, modeId, savedRegisterValues, savedAlarmThresholds, enteredAt);

  await logHistory(deviceId, currentActive, targetMode, operator, 'success', null);

  console.log(`[模式] 设备${deviceId}切换到模式"${targetMode.name}"(${modeId})`);

  return {
    success: true,
    deviceId,
    modeId,
    modeName: targetMode.name,
    writtenRegisters: writtenRegisters.length,
    appliedAlarmOverrides: appliedOverrides.length
  };
}

async function exitMode(deviceId, operator = 'system') {
  const activeMode = modeStore.getActiveMode(deviceId);
  if (!activeMode) {
    return { success: false, error: '设备当前未处于任何模式' };
  }

  const modeInfo = modeStore.getMode(activeMode.modeId);

  for (const savedReg of activeMode.savedRegisterValues) {
    const regRow = await get('SELECT data_type FROM registers WHERE device_id = ? AND address = ?', [deviceId, savedReg.address]);
    if (regRow) {
      deviceStore.setRegisterValue(deviceId, savedReg.address, regRow.data_type, savedReg.value);
    }
  }

  await restoreAlarmThresholds(activeMode.savedAlarmThresholds);

  modeStore.clearActiveMode(deviceId);

  await deleteModeState(deviceId);

  await logHistory(deviceId, activeMode, null, operator, 'success', null);

  const modeName = modeInfo ? modeInfo.name : activeMode.modeId;
  console.log(`[模式] 设备${deviceId}退出模式"${modeName}"`);

  return {
    success: true,
    deviceId,
    exitedMode: activeMode.modeId,
    exitedModeName: modeName
  };
}

async function restoreAlarmThresholds(thresholds) {
  for (const t of thresholds) {
    await run('UPDATE alarm_rules SET threshold = ? WHERE id = ?', [t.originalThreshold, t.alarmRuleId]);
  }
}

async function applyAlarmThresholds(thresholds) {
  for (const t of thresholds) {
    await run('UPDATE alarm_rules SET threshold = ? WHERE id = ?', [t.newThreshold || t.originalThreshold, t.alarmRuleId]);
  }
}

async function rollbackRegisters(deviceId, writtenRegisters) {
  for (let i = writtenRegisters.length - 1; i >= 0; i--) {
    const reg = writtenRegisters[i];
    try {
      deviceStore.setRegisterValue(deviceId, reg.address, reg.dataType, reg.originalValue);
    } catch (e) {
      console.error(`[模式回滚] 寄存器还原失败: 地址${reg.address}`, e.message);
    }
  }
}

async function logHistory(deviceId, fromActive, toMode, operator, status, errorMessage) {
  const now = Date.now();
  const fromModeId = fromActive ? fromActive.modeId : null;
  const fromModeName = fromActive ? (modeStore.getMode(fromActive.modeId)?.name || fromActive.modeId) : null;
  const toModeId = toMode ? toMode.modeId : null;
  const toModeName = toMode ? toMode.name : null;

  await run(
    `INSERT INTO device_mode_history (device_id, from_mode_id, from_mode_name, to_mode_id, to_mode_name, operator, status, error_message, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [deviceId, fromModeId, fromModeName, toModeId, toModeName, operator || 'system', status, errorMessage || null, now]
  );
}

function isRegisterLocked(deviceId, address) {
  return modeStore.isRegisterLocked(deviceId, address);
}

function getActiveMode(deviceId) {
  const active = modeStore.getActiveMode(deviceId);
  if (!active) return null;
  const modeInfo = modeStore.getMode(active.modeId);
  return {
    modeId: active.modeId,
    modeName: modeInfo ? modeInfo.name : active.modeId,
    enteredAt: active.enteredAt,
    lockedRegisters: active.lockedRegisters,
    precondition: modeInfo ? modeInfo.precondition : null
  };
}

async function getModeHistory(deviceId, limit = 100) {
  const n = Math.min(Math.max(parseInt(limit) || 100, 1), 1000);
  let sql = 'SELECT * FROM device_mode_history WHERE 1=1';
  const params = [];
  if (deviceId) {
    sql += ' AND device_id = ?';
    params.push(deviceId);
  }
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(n);
  const rows = await all(sql, params);
  return rows.map(r => ({
    id: r.id,
    deviceId: r.device_id,
    fromModeId: r.from_mode_id,
    fromModeName: r.from_mode_name,
    toModeId: r.to_mode_id,
    toModeName: r.to_mode_name,
    operator: r.operator,
    status: r.status,
    errorMessage: r.error_message,
    timestamp: r.timestamp
  }));
}

async function loadModesFromDB() {
  const modes = await all('SELECT * FROM device_modes');
  for (const m of modes) {
    const registers = await all('SELECT address, value FROM device_mode_registers WHERE mode_id = ?', [m.id]);
    const overrides = await all('SELECT alarm_rule_id, new_threshold FROM device_mode_alarm_overrides WHERE mode_id = ?', [m.id]);
    modeStore.addMode(m.id, m.device_id, m.name, m.precondition);
    modeStore.setModeRegisters(m.id, registers.map(r => ({ address: r.address, value: r.value })));
    modeStore.setModeAlarmOverrides(m.id, overrides.map(o => ({ alarmRuleId: o.alarm_rule_id, newThreshold: o.new_threshold })));
  }

  const states = await all('SELECT * FROM device_mode_state');
  for (const s of states) {
    const savedRegValues = JSON.parse(s.saved_register_values);
    const savedAlarmThresholds = JSON.parse(s.saved_alarm_thresholds);
    const modeRegisters = modeStore.getModeRegisters(s.mode_id);
    modeStore.setActiveMode(s.device_id, s.mode_id, modeRegisters, savedRegValues, savedAlarmThresholds, s.entered_at);
    const modeInfo = modeStore.getMode(s.mode_id);
    if (modeInfo) {
      console.log(`[模式] 恢复设备${s.device_id}的模式: ${modeInfo.name}`);
    }
  }

  return modes.length;
}

module.exports = {
  createMode,
  getModeById,
  getModesByDevice,
  deleteMode,
  switchMode,
  exitMode,
  isRegisterLocked,
  getActiveMode,
  getModeHistory,
  loadModesFromDB,
  checkPrecondition
};
