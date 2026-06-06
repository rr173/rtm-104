const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const trendStore = require('../store/trendStore');

function validateConfig(body) {
  if (!body.deviceId) return '缺少deviceId';
  if (body.regAddress === undefined || body.regAddress === null) return '缺少regAddress';
  if (typeof body.regAddress !== 'number') return 'regAddress必须是数字';
  if (typeof body.windowSize !== 'number' || body.windowSize < 10 || body.windowSize > 1000) {
    return '滑动窗口大小必须在10-1000之间';
  }
  if (typeof body.sensitivity !== 'undefined' && (typeof body.sensitivity !== 'number' || body.sensitivity <= 0)) {
    return '异常检测灵敏度必须是正数';
  }
  if (typeof body.intervalMs !== 'number' || body.intervalMs < 1000) {
    return '分析周期必须大于等于1000ms';
  }
  if (!deviceStore.hasDevice(body.deviceId)) return '设备不存在';
  return null;
}

function computeStats(values) {
  if (!values || values.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0, count: 0 };
  }
  const n = values.length;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let sqSum = 0;
  for (const v of values) {
    const diff = v - mean;
    sqSum += diff * diff;
  }
  const variance = n > 1 ? sqSum / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  let min = values[0];
  let max = values[0];
  for (let i = 1; i < n; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  return { mean, stddev, min, max, count: n };
}

async function createConfig(body) {
  const err = validateConfig(body);
  if (err) return { success: false, error: err };

  const id = uuidv4();
  const sensitivity = typeof body.sensitivity === 'number' ? body.sensitivity : 3.0;
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1;
  const now = Date.now();

  try {
    await run(`INSERT INTO trend_configs (id, device_id, reg_address, window_size, sensitivity, interval_ms, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, body.deviceId, body.regAddress, body.windowSize, sensitivity, body.intervalMs, enabled, now]);
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return { success: false, error: '该设备寄存器已存在趋势配置' };
    }
    throw e;
  }

  if (enabled) {
    const cfg = await getConfigById(id);
    await startConfigEngine(cfg);
  }

  return { success: true, config: await getConfigById(id) };
}

async function getConfigById(id) {
  const row = await get('SELECT * FROM trend_configs WHERE id = ?', [id]);
  if (!row) return null;
  return formatConfig(row);
}

async function getConfigByDeviceReg(deviceId, regAddress) {
  const row = await get('SELECT * FROM trend_configs WHERE device_id = ? AND reg_address = ?', [deviceId, regAddress]);
  if (!row) return null;
  return formatConfig(row);
}

function formatConfig(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    regAddress: row.reg_address,
    windowSize: row.window_size,
    sensitivity: row.sensitivity,
    intervalMs: row.interval_ms,
    enabled: !!row.enabled,
    createdAt: row.created_at
  };
}

async function getAllConfigs() {
  const rows = await all('SELECT * FROM trend_configs ORDER BY created_at');
  return rows.map(formatConfig);
}

async function deleteConfig(id) {
  const row = await get('SELECT * FROM trend_configs WHERE id = ?', [id]);
  if (!row) return false;
  trendStore.removeConfig(id, row.device_id, row.reg_address);
  await run('DELETE FROM trend_configs WHERE id = ?', [id]);
  return true;
}

const RECOVERY_CONFIRM_COUNT = 3;

async function analyzeOnce(config) {
  const rows = await all(
    `SELECT value, timestamp FROM register_history
     WHERE device_id = ? AND reg_address = ? AND stale = 0
     ORDER BY timestamp DESC LIMIT ?`,
    [config.deviceId, config.regAddress, config.windowSize]
  );

  if (rows.length < 2) {
    trendStore.setStats(config.id, {
      mean: null, stddev: null, min: null, max: null,
      deltaRate: null, lastValue: rows.length > 0 ? rows[0].value : null,
      isAnomaly: false, count: rows.length
    });
    return;
  }

  rows.reverse();
  const values = rows.map(r => r.value);
  const stats = computeStats(values);
  const lastValue = values[values.length - 1];
  const prevValue = values[values.length - 2];
  const deltaRate = prevValue !== 0 ? ((lastValue - prevValue) / Math.abs(prevValue)) * 100 : (lastValue !== 0 ? 100 : 0);

  const wasAnomaly = trendStore.isLastAnomaly(config.deviceId, config.regAddress);
  const baseline = trendStore.getNormalBaseline(config.deviceId, config.regAddress);

  let detectMean = stats.mean;
  let detectStddev = stats.stddev;
  if (wasAnomaly && baseline) {
    detectMean = baseline.mean;
    detectStddev = baseline.stddev;
  }

  let isAnomaly = wasAnomaly;
  let deviationRatio = 0;
  let outOfRange = false;

  if (detectStddev > 0) {
    deviationRatio = Math.abs(lastValue - detectMean) / detectStddev;
    outOfRange = deviationRatio > config.sensitivity;
  } else if (wasAnomaly && baseline) {
    outOfRange = Math.abs(lastValue - baseline.mean) > config.sensitivity * Math.max(baseline.stddev, 1e-9);
  }

  if (wasAnomaly) {
    if (!outOfRange) {
      const recCount = trendStore.getRecoveryCount(config.deviceId, config.regAddress) + 1;
      if (recCount >= RECOVERY_CONFIRM_COUNT) {
        isAnomaly = false;
        trendStore.setNormalBaseline(config.deviceId, config.regAddress, null);
        trendStore.setRecoveryCount(config.deviceId, config.regAddress, 0);
      } else {
        trendStore.setRecoveryCount(config.deviceId, config.regAddress, recCount);
        isAnomaly = true;
      }
    } else {
      trendStore.setRecoveryCount(config.deviceId, config.regAddress, 0);
      isAnomaly = true;
    }
  } else {
    if (outOfRange) {
      isAnomaly = true;
      trendStore.setNormalBaseline(config.deviceId, config.regAddress, {
        mean: stats.mean,
        stddev: Math.max(stats.stddev, 1e-9)
      });
    } else {
      isAnomaly = false;
    }
  }

  if (isAnomaly && !wasAnomaly) {
    await run(
      `INSERT INTO trend_anomalies (timestamp, device_id, reg_address, anomaly_value, mean, stddev, deviation_ratio)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [Date.now(), config.deviceId, config.regAddress, lastValue, detectMean, detectStddev, deviationRatio]
    );
  }

  if (isAnomaly !== wasAnomaly) {
    trendStore.setAnomalyState(config.deviceId, config.regAddress, isAnomaly);
  }

  trendStore.setStats(config.id, {
    mean: stats.mean,
    stddev: stats.stddev,
    min: stats.min,
    max: stats.max,
    deltaRate,
    lastValue,
    isAnomaly,
    count: stats.count
  });
}

async function startConfigEngine(config) {
  trendStore.clearTimer(config.id);
  const timer = setInterval(async () => {
    try {
      await analyzeOnce(config);
    } catch (e) {
      console.error('趋势分析错误:', config.id, e.message);
    }
  }, config.intervalMs);
  timer.unref();
  trendStore.setTimer(config.id, timer);

  setTimeout(async () => {
    try { await analyzeOnce(config); } catch (e) {}
  }, 200);
}

async function startEngineForAll() {
  const configs = await getAllConfigs();
  for (const c of configs) {
    if (c.enabled) {
      await startConfigEngine(c);
    }
  }
  console.log(`趋势引擎已启动，共 ${configs.filter(c => c.enabled).length} 个配置`);
}

function stopEngine() {
  trendStore.clearAllTimers();
}

async function getStatsSnapshot() {
  const configs = await getAllConfigs();
  const result = [];
  for (const cfg of configs) {
    const device = await get('SELECT name FROM devices WHERE id = ?', [cfg.deviceId]);
    const reg = await get('SELECT name FROM registers WHERE device_id = ? AND address = ?', [cfg.deviceId, cfg.regAddress]);
    const s = trendStore.getStats(cfg.id) || {};
    result.push({
      configId: cfg.id,
      deviceId: cfg.deviceId,
      deviceName: device ? device.name : null,
      regAddress: cfg.regAddress,
      regName: reg ? reg.name : null,
      mean: s.mean,
      stddev: s.stddev,
      min: s.min,
      max: s.max,
      deltaRate: s.deltaRate,
      lastValue: s.lastValue,
      isAnomaly: !!s.isAnomaly
    });
  }
  return result;
}

async function getAnomalies(deviceId, limit) {
  const lim = Math.min(Math.max(parseInt(limit) || 100, 1), 1000);
  let sql = `
    SELECT a.*, d.name as device_name, r.name as reg_name
    FROM trend_anomalies a
    JOIN devices d ON a.device_id = d.id
    LEFT JOIN registers r ON a.device_id = r.device_id AND a.reg_address = r.address
  `;
  const params = [];
  if (deviceId) {
    sql += ' WHERE a.device_id = ?';
    params.push(deviceId);
  }
  sql += ' ORDER BY a.timestamp DESC LIMIT ?';
  params.push(lim);

  const rows = await all(sql, params);
  return rows.map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    deviceId: r.device_id,
    deviceName: r.device_name,
    regAddress: r.reg_address,
    regName: r.reg_name,
    anomalyValue: r.anomaly_value,
    mean: r.mean,
    stddev: r.stddev,
    deviationRatio: r.deviation_ratio
  }));
}

function parseWindowMs(windowStr) {
  if (!windowStr) return 60 * 1000;
  const match = windowStr.match(/^(\d+)(s|m|h)$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  let ms;
  switch (unit) {
    case 's': ms = value * 1000; break;
    case 'm': ms = value * 60 * 1000; break;
    case 'h': ms = value * 3600 * 1000; break;
    default: ms = 60 * 1000;
  }
  if (ms > 24 * 3600 * 1000) return null;
  return ms;
}

async function getCurveData(deviceId, regAddress, windowStr) {
  const windowMs = parseWindowMs(windowStr);
  if (windowMs === null) return { success: false, error: 'window参数格式错误，支持s/m/h后缀，最大24h' };

  const cfg = await getConfigByDeviceReg(deviceId, regAddress);
  if (!cfg) return { success: false, error: '该设备寄存器未配置趋势分析' };

  const now = Date.now();
  const startTime = now - windowMs;

  const rows = await all(
    `SELECT value, timestamp FROM register_history
     WHERE device_id = ? AND reg_address = ? AND stale = 0 AND timestamp >= ?
     ORDER BY timestamp ASC`,
    [deviceId, regAddress, startTime]
  );

  const points = [];
  for (let i = 0; i < rows.length; i++) {
    const windowStart = Math.max(0, i - cfg.windowSize + 1);
    const windowValues = [];
    for (let j = windowStart; j <= i; j++) {
      windowValues.push(rows[j].value);
    }
    const s = computeStats(windowValues);
    const upperBound = s.mean + cfg.sensitivity * s.stddev;
    const lowerBound = s.mean - cfg.sensitivity * s.stddev;
    points.push({
      timestamp: rows[i].timestamp,
      value: rows[i].value,
      mean: s.mean,
      upperBound,
      lowerBound
    });
  }

  return { success: true, points };
}

module.exports = {
  createConfig,
  getConfigById,
  getAllConfigs,
  deleteConfig,
  startEngineForAll,
  stopEngine,
  getStatsSnapshot,
  getAnomalies,
  getCurveData,
  analyzeOnce,
  computeStats
};
