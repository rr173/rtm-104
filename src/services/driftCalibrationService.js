const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const modeService = require('./modeService');
const maintenanceService = require('./maintenanceService');
const deviceService = require('./deviceService');

const timers = new Map();
const lastCalibrationTime = new Map();

function validateConfig(body) {
  if (!body.deviceId) return '缺少deviceId';
  if (!deviceStore.hasDevice(body.deviceId)) return '设备不存在';
  if (typeof body.regAddress !== 'number' || body.regAddress < 0 || body.regAddress > 65535) {
    return 'regAddress必须在0-65535之间';
  }
  if (typeof body.baselineValue !== 'number') return 'baselineValue必须是数字';
  if (typeof body.driftTolerance !== 'number' || body.driftTolerance <= 0) {
    return 'driftTolerance必须是正数';
  }
  if (typeof body.detectIntervalMs !== 'number' || body.detectIntervalMs < 1000) {
    return 'detectIntervalMs必须>=1000毫秒';
  }
  if (typeof body.windowSize !== 'number' || body.windowSize < 2) {
    return 'windowSize必须>=2';
  }
  if (body.autoCalibrate) {
    if (typeof body.calibrateTargetReg !== 'number' || body.calibrateTargetReg < 0 || body.calibrateTargetReg > 65535) {
      return '启用自动校准时必须提供有效的calibrateTargetReg';
    }
    if (body.compensateDirection && !['add', 'subtract', 'set'].includes(body.compensateDirection)) {
      return 'compensateDirection必须是add/subtract/set之一';
    }
  }
  if (typeof body.coolDownSeconds !== 'number' || body.coolDownSeconds < 0) {
    return 'coolDownSeconds必须>=0';
  }
  return null;
}

function formatConfig(row) {
  if (!row) return null;
  return {
    id: row.id,
    deviceId: row.device_id,
    regAddress: row.reg_address,
    regName: row.reg_name,
    baselineValue: row.baseline_value,
    driftTolerance: row.drift_tolerance,
    detectIntervalMs: row.detect_interval_ms,
    windowSize: row.window_size,
    autoCalibrate: !!row.auto_calibrate,
    calibrateTargetReg: row.calibrate_target_reg,
    compensateDirection: row.compensate_direction,
    coolDownSeconds: row.cool_down_seconds,
    enabled: !!row.enabled,
    createdAt: row.created_at
  };
}

function formatEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    configId: row.config_id,
    deviceId: row.device_id,
    regAddress: row.reg_address,
    regName: row.reg_name,
    baselineValue: row.baseline_value,
    driftValue: row.drift_value,
    currentMean: row.current_mean,
    deviation: row.deviation,
    eventType: row.event_type,
    detectedAt: row.detected_at,
    recoveredAt: row.recovered_at,
    active: !!row.active
  };
}

function formatCalibration(row) {
  if (!row) return null;
  return {
    id: row.id,
    configId: row.config_id,
    deviceId: row.device_id,
    regAddress: row.reg_address,
    regName: row.reg_name,
    calibrateType: row.calibrate_type,
    beforeMean: row.before_mean,
    afterMean: row.after_mean,
    compensateValue: row.compensate_value,
    targetRegAddress: row.target_reg_address,
    status: row.status,
    errorMessage: row.error_message,
    triggerSource: row.trigger_source,
    performedAt: row.performed_at,
    updatedBaseline: row.updated_baseline
  };
}

async function createConfig(body) {
  const err = validateConfig(body);
  if (err) return { success: false, error: err, code: 400 };

  const existing = await get(
    'SELECT id FROM drift_monitor_configs WHERE device_id = ? AND reg_address = ?',
    [body.deviceId, body.regAddress]
  );
  if (existing) {
    return { success: false, error: '该寄存器的漂移监控配置已存在', code: 409 };
  }

  const regInfo = await get(
    'SELECT name, data_type FROM registers WHERE device_id = ? AND address = ?',
    [body.deviceId, body.regAddress]
  );

  const id = uuidv4();
  const now = Date.now();

  await run(
    `INSERT INTO drift_monitor_configs
     (id, device_id, reg_address, reg_name, baseline_value, drift_tolerance,
      detect_interval_ms, window_size, auto_calibrate, calibrate_target_reg,
      compensate_direction, cool_down_seconds, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, body.deviceId, body.regAddress, regInfo ? regInfo.name : null,
      body.baselineValue, body.driftTolerance,
      body.detectIntervalMs, body.windowSize,
      body.autoCalibrate ? 1 : 0,
      body.autoCalibrate ? body.calibrateTargetReg : null,
      body.compensateDirection || 'add',
      body.coolDownSeconds,
      body.enabled !== false ? 1 : 0,
      now
    ]
  );

  const config = await getConfigById(id);
  if (config && config.enabled) {
    scheduleDetection(config);
  }

  return { success: true, config };
}

async function getConfigById(id) {
  const row = await get('SELECT * FROM drift_monitor_configs WHERE id = ?', [id]);
  return formatConfig(row);
}

async function getConfigsByDevice(deviceId) {
  const rows = await all(
    'SELECT * FROM drift_monitor_configs WHERE device_id = ? ORDER BY created_at',
    [deviceId]
  );
  return rows.map(formatConfig);
}

async function getAllConfigs() {
  const rows = await all('SELECT * FROM drift_monitor_configs ORDER BY created_at');
  return rows.map(formatConfig);
}

async function getConfigWithStatus(deviceId, regAddress) {
  const config = await get(
    'SELECT * FROM drift_monitor_configs WHERE device_id = ? AND reg_address = ?',
    [deviceId, regAddress]
  );
  if (!config) return null;

  const formatted = formatConfig(config);
  return await enrichConfigWithStatus(formatted);
}

async function getAllConfigsWithStatus() {
  const configs = await getAllConfigs();
  const result = [];
  for (const cfg of configs) {
    result.push(await enrichConfigWithStatus(cfg));
  }
  return result;
}

async function enrichConfigWithStatus(config) {
  const activeEvent = await get(
    'SELECT * FROM drift_events WHERE config_id = ? AND active = 1 ORDER BY detected_at DESC LIMIT 1',
    [config.id]
  );

  const meanResult = await getWindowMean(config.deviceId, config.regAddress, config.windowSize);
  const deviceStatus = deviceStore.getStatus(config.deviceId);
  const underMaintenance = maintenanceService.isDeviceLocked(config.deviceId);
  const targetLocked = config.autoCalibrate && config.calibrateTargetReg !== null
    ? modeService.isRegisterLocked(config.deviceId, config.calibrateTargetReg)
    : false;

  const lastCalibration = await get(
    'SELECT performed_at, status FROM calibration_history WHERE config_id = ? ORDER BY performed_at DESC LIMIT 1',
    [config.id]
  );

  const inCoolDown = lastCalibration && lastCalibration.status === 'success'
    ? (Date.now() - lastCalibration.performed_at) / 1000 < config.coolDownSeconds
    : false;

  return {
    ...config,
    driftStatus: activeEvent ? 'drifting' : 'normal',
    activeDriftEvent: activeEvent ? formatEvent(activeEvent) : null,
    currentMean: meanResult.success ? meanResult.mean : null,
    sampleCount: meanResult.sampleCount || 0,
    validSampleCount: meanResult.validCount || 0,
    maintenanceSampleCount: meanResult.maintenanceCount || 0,
    deviceStatus,
    underMaintenance,
    targetRegisterLocked: targetLocked,
    inCoolDown,
    lastCalibrationAt: lastCalibration ? lastCalibration.performed_at : null,
    dataSufficient: meanResult.success
  };
}

async function updateConfig(id, body) {
  const config = await get('SELECT * FROM drift_monitor_configs WHERE id = ?', [id]);
  if (!config) return { success: false, error: '配置不存在', code: 404 };

  const updates = [];
  const params = [];

  if (body.baselineValue !== undefined) {
    if (typeof body.baselineValue !== 'number') return { success: false, error: 'baselineValue必须是数字', code: 400 };
    updates.push('baseline_value = ?');
    params.push(body.baselineValue);
  }
  if (body.driftTolerance !== undefined) {
    if (typeof body.driftTolerance !== 'number' || body.driftTolerance <= 0) {
      return { success: false, error: 'driftTolerance必须是正数', code: 400 };
    }
    updates.push('drift_tolerance = ?');
    params.push(body.driftTolerance);
  }
  if (body.detectIntervalMs !== undefined) {
    if (typeof body.detectIntervalMs !== 'number' || body.detectIntervalMs < 1000) {
      return { success: false, error: 'detectIntervalMs必须>=1000', code: 400 };
    }
    updates.push('detect_interval_ms = ?');
    params.push(body.detectIntervalMs);
  }
  if (body.windowSize !== undefined) {
    if (typeof body.windowSize !== 'number' || body.windowSize < 2) {
      return { success: false, error: 'windowSize必须>=2', code: 400 };
    }
    updates.push('window_size = ?');
    params.push(body.windowSize);
  }
  if (body.autoCalibrate !== undefined) {
    updates.push('auto_calibrate = ?');
    params.push(body.autoCalibrate ? 1 : 0);
  }
  if (body.calibrateTargetReg !== undefined) {
    if (typeof body.calibrateTargetReg !== 'number' || body.calibrateTargetReg < 0 || body.calibrateTargetReg > 65535) {
      return { success: false, error: 'calibrateTargetReg无效', code: 400 };
    }
    updates.push('calibrate_target_reg = ?');
    params.push(body.calibrateTargetReg);
  }
  if (body.compensateDirection !== undefined) {
    if (!['add', 'subtract', 'set'].includes(body.compensateDirection)) {
      return { success: false, error: 'compensateDirection无效', code: 400 };
    }
    updates.push('compensate_direction = ?');
    params.push(body.compensateDirection);
  }
  if (body.coolDownSeconds !== undefined) {
    if (typeof body.coolDownSeconds !== 'number' || body.coolDownSeconds < 0) {
      return { success: false, error: 'coolDownSeconds必须>=0', code: 400 };
    }
    updates.push('cool_down_seconds = ?');
    params.push(body.coolDownSeconds);
  }
  if (body.enabled !== undefined) {
    updates.push('enabled = ?');
    params.push(body.enabled ? 1 : 0);
  }

  if (updates.length === 0) {
    return { success: true, config: await getConfigById(id) };
  }

  params.push(id);
  await run(`UPDATE drift_monitor_configs SET ${updates.join(', ')} WHERE id = ?`, params);

  const newConfig = await getConfigById(id);
  stopDetection(id);
  if (newConfig && newConfig.enabled) {
    scheduleDetection(newConfig);
  }

  return { success: true, config: newConfig };
}

async function deleteConfig(id) {
  const config = await get('SELECT id FROM drift_monitor_configs WHERE id = ?', [id]);
  if (!config) return { success: false, error: '配置不存在', code: 404 };

  stopDetection(id);
  lastCalibrationTime.delete(id);

  await run('DELETE FROM drift_monitor_configs WHERE id = ?', [id]);
  await run('DELETE FROM drift_events WHERE config_id = ?', [id]);
  await run('DELETE FROM calibration_history WHERE config_id = ?', [id]);

  return { success: true };
}

async function getWindowMean(deviceId, regAddress, windowSize) {
  const rows = await all(
    `SELECT value, stale FROM register_history
     WHERE device_id = ? AND reg_address = ? AND stale != 1
     ORDER BY timestamp DESC LIMIT ?`,
    [deviceId, regAddress, windowSize]
  );

  if (rows.length < Math.min(2, windowSize)) {
    return { success: false, error: '历史数据点不足', sampleCount: rows.length };
  }

  const validRows = rows.filter(r => r.stale === 0);
  const maintenanceRows = rows.filter(r => r.stale === 2);
  const sum = rows.reduce((s, r) => s + r.value, 0);
  return {
    success: true,
    mean: sum / rows.length,
    sampleCount: rows.length,
    validCount: validRows.length,
    maintenanceCount: maintenanceRows.length
  };
}

async function createDriftEvent(config, currentMean, deviation) {
  const now = Date.now();
  await run(
    `INSERT INTO drift_events
     (config_id, device_id, reg_address, reg_name, baseline_value, drift_value,
      current_mean, deviation, event_type, detected_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      config.id, config.deviceId, config.regAddress, config.regName,
      config.baselineValue, config.driftTolerance,
      currentMean, deviation, 'drift', now, 1
    ]
  );
}

async function recoverDriftEvent(configId) {
  const activeEvent = await get(
    'SELECT id FROM drift_events WHERE config_id = ? AND active = 1 ORDER BY detected_at DESC LIMIT 1',
    [configId]
  );
  if (!activeEvent) return false;

  await run(
    'UPDATE drift_events SET active = 0, recovered_at = ? WHERE id = ?',
    [Date.now(), activeEvent.id]
  );
  return true;
}

async function getActiveDriftEvent(configId) {
  const row = await get(
    'SELECT * FROM drift_events WHERE config_id = ? AND active = 1 ORDER BY detected_at DESC LIMIT 1',
    [configId]
  );
  return row || null;
}

function canCalibrate(config) {
  const status = deviceStore.getStatus(config.deviceId);
  if (status !== 'online') {
    return { ok: false, reason: `设备离线(status=${status})` };
  }

  if (maintenanceService.isDeviceLocked(config.deviceId)) {
    return { ok: false, reason: '设备维保中' };
  }

  if (config.autoCalibrate && config.calibrateTargetReg !== null) {
    if (modeService.isRegisterLocked(config.deviceId, config.calibrateTargetReg)) {
      const activeMode = modeService.getActiveMode(config.deviceId);
      const modeName = activeMode ? activeMode.modeName : '未知';
      return { ok: false, reason: `模式锁定跳过("${modeName}"模式锁定了校准目标寄存器)` };
    }
  }

  return { ok: true };
}

function checkCoolDown(configId, coolDownSeconds) {
  const last = lastCalibrationTime.get(configId);
  if (!last) return true;
  const elapsed = (Date.now() - last) / 1000;
  return elapsed >= coolDownSeconds;
}

async function computeNewTargetValue(config, currentTargetValue, compensateValue) {
  switch (config.compensateDirection) {
    case 'add':
      return currentTargetValue + compensateValue;
    case 'subtract':
      return currentTargetValue - compensateValue;
    case 'set':
      return compensateValue;
    default:
      return currentTargetValue + compensateValue;
  }
}

async function performCalibration(config, beforeMean, triggerSource, manualCompensateValue = null) {
  const now = Date.now();
  const calibId = uuidv4();

  if (!config.autoCalibrate || config.calibrateTargetReg === null) {
    await run(
      `INSERT INTO calibration_history
       (config_id, device_id, reg_address, reg_name, calibrate_type, before_mean, after_mean,
        compensate_value, target_reg_address, status, error_message, trigger_source, performed_at, updated_baseline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        config.id, config.deviceId, config.regAddress, config.regName,
        manualCompensateValue !== null ? 'manual' : 'auto',
        beforeMean, null,
        manualCompensateValue !== null ? manualCompensateValue : 0,
        null,
        'skipped',
        '未配置自动校准目标寄存器',
        triggerSource, now, null
      ]
    );
    return { success: false, error: '未配置自动校准目标寄存器' };
  }

  const check = canCalibrate(config);
  if (!check.ok) {
    const isModeLock = check.reason.includes('模式锁定');
    await run(
      `INSERT INTO calibration_history
       (config_id, device_id, reg_address, reg_name, calibrate_type, before_mean, after_mean,
        compensate_value, target_reg_address, status, error_message, trigger_source, performed_at, updated_baseline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        config.id, config.deviceId, config.regAddress, config.regName,
        manualCompensateValue !== null ? 'manual' : 'auto',
        beforeMean, null,
        manualCompensateValue !== null ? manualCompensateValue : 0,
        config.calibrateTargetReg,
        isModeLock ? 'mode_lock_skipped' : 'failed',
        check.reason,
        triggerSource, now, null
      ]
    );
    return { success: false, error: check.reason, status: isModeLock ? 'mode_lock_skipped' : 'failed' };
  }

  const compensateValue = manualCompensateValue !== null
    ? manualCompensateValue
    : (config.baselineValue - beforeMean);

  const targetRegInfo = await get(
    'SELECT data_type FROM registers WHERE device_id = ? AND address = ?',
    [config.deviceId, config.calibrateTargetReg]
  );
  if (!targetRegInfo) {
    await run(
      `INSERT INTO calibration_history
       (config_id, device_id, reg_address, reg_name, calibrate_type, before_mean, after_mean,
        compensate_value, target_reg_address, status, error_message, trigger_source, performed_at, updated_baseline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        config.id, config.deviceId, config.regAddress, config.regName,
        manualCompensateValue !== null ? 'manual' : 'auto',
        beforeMean, null, compensateValue,
        config.calibrateTargetReg, 'failed',
        '校准目标寄存器不存在',
        triggerSource, now, null
      ]
    );
    return { success: false, error: '校准目标寄存器不存在' };
  }

  let currentTargetValue = 0;
  try {
    const { value } = deviceStore.getRegisterValue(
      config.deviceId, config.calibrateTargetReg, targetRegInfo.data_type
    );
    currentTargetValue = value;
  } catch (e) {
    // ignore
  }

  const newTargetValue = await computeNewTargetValue(config, currentTargetValue, compensateValue);

  const writeResult = await deviceService.writeRegister(
    config.deviceId, config.calibrateTargetReg, newTargetValue, 'calibration'
  );

  if (!writeResult.success) {
    await run(
      `INSERT INTO calibration_history
       (config_id, device_id, reg_address, reg_name, calibrate_type, before_mean, after_mean,
        compensate_value, target_reg_address, status, error_message, trigger_source, performed_at, updated_baseline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        config.id, config.deviceId, config.regAddress, config.regName,
        manualCompensateValue !== null ? 'manual' : 'auto',
        beforeMean, null, compensateValue,
        config.calibrateTargetReg, 'failed',
        writeResult.error, triggerSource, now, null
      ]
    );
    return { success: false, error: writeResult.error };
  }

  lastCalibrationTime.set(config.id, now);

  await new Promise(resolve => setTimeout(resolve, 100));

  const afterCheck = await getWindowMean(config.deviceId, config.regAddress, Math.min(5, config.windowSize));
  const afterMean = afterCheck.success ? afterCheck.mean : beforeMean + compensateValue;

  const newBaseline = manualCompensateValue !== null ? afterMean : beforeMean + compensateValue;
  await run(
    'UPDATE drift_monitor_configs SET baseline_value = ? WHERE id = ?',
    [newBaseline, config.id]
  );

  await run(
    `INSERT INTO calibration_history
     (config_id, device_id, reg_address, reg_name, calibrate_type, before_mean, after_mean,
      compensate_value, target_reg_address, status, error_message, trigger_source, performed_at, updated_baseline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      config.id, config.deviceId, config.regAddress, config.regName,
      manualCompensateValue !== null ? 'manual' : 'auto',
      beforeMean, afterMean, compensateValue,
      config.calibrateTargetReg, 'success', null,
      triggerSource, now, newBaseline
    ]
  );

  await recoverDriftEvent(config.id);

  const updatedConfig = await getConfigById(config.id);
  return { success: true, beforeMean, afterMean, compensateValue, newBaseline, config: updatedConfig };
}

async function detectAndCalibrate(configId) {
  const config = await getConfigById(configId);
  if (!config || !config.enabled) {
    stopDetection(configId);
    return;
  }

  const meanResult = await getWindowMean(config.deviceId, config.regAddress, config.windowSize);
  if (!meanResult.success) {
    return;
  }

  if (meanResult.maintenanceCount > 0 && meanResult.validCount === 0) {
    console.debug(`[漂移检测] ${config.regName || `reg${config.regAddress}`}: 窗口内${meanResult.maintenanceCount}个点均为维保中数据，仅供参考`);
  }

  const currentMean = meanResult.mean;
  const deviation = currentMean - config.baselineValue;
  const absDeviation = Math.abs(deviation);
  const isDrifting = absDeviation > config.driftTolerance;

  const activeEvent = await getActiveDriftEvent(configId);

  if (isDrifting) {
    if (!activeEvent) {
      await createDriftEvent(config, currentMean, deviation);
      console.log(`[漂移检测] ${config.regName || `reg${config.regAddress}`} 发生漂移: 均值=${currentMean.toFixed(3)}, 基准=${config.baselineValue}, 偏差=${deviation.toFixed(3)} (容限${config.driftTolerance})`);
    }

    if (config.autoCalibrate && config.calibrateTargetReg !== null) {
      const cooled = checkCoolDown(configId, config.coolDownSeconds);
      if (!cooled) {
        return;
      }

      const lastFailedCal = await get(
        `SELECT id, performed_at FROM calibration_history
         WHERE config_id = ? AND status != 'success' AND status != 'skipped'
         ORDER BY performed_at DESC LIMIT 1`,
        [configId]
      );

      const check = canCalibrate(config);
      if (!check.ok) {
        const minIntervalMs = 30000;
        const now = Date.now();
        const shouldRecord = !lastFailedCal || (now - lastFailedCal.performed_at) > minIntervalMs;

        if (shouldRecord) {
          const isModeLock = check.reason.includes('模式锁定');
          const status = isModeLock ? 'mode_lock_skipped' : 'failed';
          await run(
            `INSERT INTO calibration_history
             (config_id, device_id, reg_address, reg_name, calibrate_type, before_mean, after_mean,
              compensate_value, target_reg_address, status, error_message, trigger_source, performed_at, updated_baseline)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              config.id, config.deviceId, config.regAddress, config.regName,
              'auto', currentMean, null, config.baselineValue - currentMean,
              config.calibrateTargetReg, status, check.reason,
              'auto', now, null
            ]
          );
          console.log(`[自动校准] ${config.regName || `reg${config.regAddress}`} 跳过: ${check.reason}`);
        }
        return;
      }

      console.log(`[自动校准] 执行 ${config.regName || `reg${config.regAddress}`}: 补偿=${(config.baselineValue - currentMean).toFixed(3)}`);
      const result = await performCalibration(config, currentMean, 'auto');
      if (!result.success) {
        console.warn(`[自动校准] 失败: ${result.error}`);
      } else {
        console.log(`[自动校准] 成功: 修正后均值=${result.afterMean.toFixed(3)}, 新基准=${result.newBaseline.toFixed(3)}`);
      }
    }
  } else {
    if (activeEvent) {
      await recoverDriftEvent(configId);
      console.log(`[漂移检测] ${config.regName || `reg${config.regAddress}`} 漂移恢复: 均值=${currentMean.toFixed(3)}, 基准=${config.baselineValue}`);
    }
  }
}

function scheduleDetection(config) {
  stopDetection(config.id);
  const timer = setInterval(() => {
    detectAndCalibrate(config.id).catch(err => {
      console.error('[漂移检测] 周期检测出错:', err.message);
    });
  }, config.detectIntervalMs);
  timers.set(config.id, timer);
}

function stopDetection(configId) {
  const timer = timers.get(configId);
  if (timer) {
    clearInterval(timer);
    timers.delete(configId);
  }
}

async function manualCalibrate(configId, manualCompensateValue) {
  const config = await getConfigById(configId);
  if (!config) return { success: false, error: '配置不存在', code: 404 };

  if (typeof manualCompensateValue !== 'number') {
    return { success: false, error: 'manualCompensateValue必须是数字', code: 400 };
  }

  const check = canCalibrate(config);
  if (!check.ok) {
    return { success: false, error: check.reason, code: 400 };
  }

  const meanResult = await getWindowMean(config.deviceId, config.regAddress, config.windowSize);
  const beforeMean = meanResult.success ? meanResult.mean : config.baselineValue;

  console.log(`[手动校准] ${config.regName || `reg${config.regAddress}`}: 补偿=${manualCompensateValue}`);
  const result = await performCalibration(config, beforeMean, 'manual', manualCompensateValue);

  if (result.success) {
    return { success: true, ...result };
  }
  return { success: false, error: result.error, code: 400 };
}

async function getDriftEvents(deviceId = null, startTime = null, endTime = null, activeOnly = false) {
  let sql = 'SELECT * FROM drift_events WHERE 1=1';
  const params = [];

  if (deviceId) {
    sql += ' AND device_id = ?';
    params.push(deviceId);
  }
  if (startTime) {
    sql += ' AND detected_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND detected_at <= ?';
    params.push(endTime);
  }
  if (activeOnly) {
    sql += ' AND active = 1';
  }

  sql += ' ORDER BY detected_at DESC LIMIT 500';
  const rows = await all(sql, params);
  return rows.map(formatEvent);
}

async function getCalibrationHistory(deviceId = null, startTime = null, endTime = null, status = null) {
  let sql = 'SELECT * FROM calibration_history WHERE 1=1';
  const params = [];

  if (deviceId) {
    sql += ' AND device_id = ?';
    params.push(deviceId);
  }
  if (startTime) {
    sql += ' AND performed_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND performed_at <= ?';
    params.push(endTime);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  sql += ' ORDER BY performed_at DESC LIMIT 500';
  const rows = await all(sql, params);
  return rows.map(formatCalibration);
}

async function startEngine() {
  const configs = await all('SELECT * FROM drift_monitor_configs WHERE enabled = 1');
  let count = 0;
  for (const row of configs) {
    const config = formatConfig(row);
    scheduleDetection(config);
    count++;
  }
  console.log(`漂移校准引擎启动: 共 ${count} 个漂移监控配置已加载`);
  return count;
}

function stopEngine() {
  for (const [id, timer] of timers) {
    clearInterval(timer);
  }
  timers.clear();
  console.log('漂移校准引擎已停止');
}

async function loadFromDB() {
  const rows = await all('SELECT id, device_id, reg_address FROM drift_monitor_configs');
  return rows.length;
}

module.exports = {
  createConfig,
  getConfigById,
  getConfigsByDevice,
  getAllConfigs,
  getConfigWithStatus,
  getAllConfigsWithStatus,
  updateConfig,
  deleteConfig,
  manualCalibrate,
  getDriftEvents,
  getCalibrationHistory,
  startEngine,
  stopEngine,
  loadFromDB,
  getWindowMean
};
