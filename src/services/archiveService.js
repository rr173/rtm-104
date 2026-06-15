const { run, get, all } = require('../db/database');

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_GRANULARITY_SECONDS = 3600;
const SCHEDULED_INTERVAL_MS = 60 * 60 * 1000;

let archiveTimer = null;
let isRunning = false;

function parseGranularity(granularityStr) {
  if (typeof granularityStr === 'number') {
    return granularityStr;
  }
  const match = granularityStr.match(/^(\d+)(s|m|h)$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    default: return null;
  }
}

function formatGranularity(seconds) {
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }
  return `${seconds}s`;
}

async function getPolicy(deviceId) {
  const row = await get('SELECT * FROM archive_policies WHERE device_id = ?', [deviceId]);
  if (!row) {
    return {
      deviceId,
      retentionDays: DEFAULT_RETENTION_DAYS,
      granularitySeconds: DEFAULT_GRANULARITY_SECONDS,
      granularity: formatGranularity(DEFAULT_GRANULARITY_SECONDS),
      enabled: true
    };
  }
  return {
    id: row.id,
    deviceId: row.device_id,
    retentionDays: row.retention_days,
    granularitySeconds: row.granularity_seconds,
    granularity: formatGranularity(row.granularity_seconds),
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getAllPolicies() {
  const rows = await all('SELECT * FROM archive_policies ORDER BY device_id');
  return rows.map(row => ({
    id: row.id,
    deviceId: row.device_id,
    retentionDays: row.retention_days,
    granularitySeconds: row.granularity_seconds,
    granularity: formatGranularity(row.granularity_seconds),
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

async function setPolicy(deviceId, options) {
  const now = Date.now();
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const granularitySeconds = options.granularitySeconds ?? DEFAULT_GRANULARITY_SECONDS;
  const enabled = options.enabled !== undefined ? (options.enabled ? 1 : 0) : 1;

  if (retentionDays < 1) {
    return { success: false, error: '保留天数必须大于0' };
  }
  if (granularitySeconds < 1) {
    return { success: false, error: '归档粒度必须大于0秒' };
  }

  const existing = await get('SELECT id FROM archive_policies WHERE device_id = ?', [deviceId]);
  
  if (existing) {
    await run(`UPDATE archive_policies 
      SET retention_days = ?, granularity_seconds = ?, enabled = ?, updated_at = ?
      WHERE device_id = ?`,
      [retentionDays, granularitySeconds, enabled, now, deviceId]);
  } else {
    await run(`INSERT INTO archive_policies 
      (device_id, retention_days, granularity_seconds, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [deviceId, retentionDays, granularitySeconds, enabled, now, now]);
  }

  return { success: true, policy: await getPolicy(deviceId) };
}

async function deletePolicy(deviceId) {
  const result = await run('DELETE FROM archive_policies WHERE device_id = ?', [deviceId]);
  return result.changes > 0;
}

async function downsampleAndArchive(deviceId, regAddress, beforeTimestamp, windowSeconds) {
  const rows = await all(`
    SELECT value, timestamp
    FROM register_history
    WHERE device_id = ? AND reg_address = ? AND timestamp < ?
    ORDER BY timestamp ASC
  `, [deviceId, regAddress, beforeTimestamp]);

  if (rows.length === 0) {
    return { archived: 0, deleted: 0 };
  }

  const windows = new Map();
  
  for (const row of rows) {
    const windowStart = Math.floor(row.timestamp / 1000 / windowSeconds) * windowSeconds * 1000;
    if (!windows.has(windowStart)) {
      windows.set(windowStart, {
        sum: 0,
        count: 0,
        max: -Infinity,
        min: Infinity
      });
    }
    const w = windows.get(windowStart);
    w.sum += row.value;
    w.count++;
    if (row.value > w.max) w.max = row.value;
    if (row.value < w.min) w.min = row.value;
  }

  let archivedCount = 0;
  for (const [ts, w] of windows.entries()) {
    await run(`
      INSERT INTO register_history_archive 
      (device_id, reg_address, avg_value, max_value, min_value, sample_count, timestamp, window_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [deviceId, regAddress, w.sum / w.count, w.max, w.min, w.count, ts, windowSeconds]);
    archivedCount++;
  }

  const deleteResult = await run(`
    DELETE FROM register_history
    WHERE device_id = ? AND reg_address = ? AND timestamp < ?
  `, [deviceId, regAddress, beforeTimestamp]);

  return { archived: archivedCount, deleted: deleteResult.changes };
}

async function runArchive(options = {}) {
  if (isRunning) {
    return { success: false, error: '归档任务已在运行中' };
  }

  isRunning = true;
  const triggeredBy = options.triggeredBy || 'scheduled';
  const customRetentionDays = options.customRetentionDays || null;

  const runIdResult = await run(`
    INSERT INTO archive_runs (started_at, status, triggered_by, custom_retention_days)
    VALUES (?, 'running', ?, ?)
  `, [Date.now(), triggeredBy, customRetentionDays]);
  
  const runId = runIdResult.lastID;
  
  try {
    const policies = await getAllPolicies();
    const enabledPolicies = policies.filter(p => p.enabled);
    
    let totalArchived = 0;
    let totalDeleted = 0;
    let devicesProcessed = 0;

    for (const policy of enabledPolicies) {
      const retentionDays = customRetentionDays || policy.retentionDays;
      const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
      const beforeTimestamp = Date.now() - retentionMs;
      const windowSeconds = policy.granularitySeconds;

      const addresses = await all(`
        SELECT DISTINCT reg_address 
        FROM register_history 
        WHERE device_id = ? AND timestamp < ?
      `, [policy.deviceId, beforeTimestamp]);

      if (addresses.length === 0) continue;

      let deviceArchived = 0;
      let deviceDeleted = 0;

      for (const addr of addresses) {
        const result = await downsampleAndArchive(
          policy.deviceId, 
          addr.reg_address, 
          beforeTimestamp, 
          windowSeconds
        );
        deviceArchived += result.archived;
        deviceDeleted += result.deleted;
      }

      totalArchived += deviceArchived;
      totalDeleted += deviceDeleted;
      devicesProcessed++;
    }

    await run(`
      UPDATE archive_runs 
      SET finished_at = ?, status = 'completed', 
          total_archived = ?, total_deleted = ?, devices_processed = ?
      WHERE id = ?
    `, [Date.now(), totalArchived, totalDeleted, devicesProcessed, runId]);

    return { 
      success: true, 
      runId, 
      totalArchived, 
      totalDeleted, 
      devicesProcessed 
    };
  } catch (e) {
    await run(`
      UPDATE archive_runs 
      SET finished_at = ?, status = 'failed', error_message = ?
      WHERE id = ?
    `, [Date.now(), e.message, runId]);
    throw e;
  } finally {
    isRunning = false;
  }
}

async function getArchiveRuns(limit = 20) {
  const rows = await all(`
    SELECT * FROM archive_runs 
    ORDER BY started_at DESC 
    LIMIT ?
  `, [limit]);
  
  return rows.map(row => ({
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    totalArchived: row.total_archived,
    totalDeleted: row.total_deleted,
    devicesProcessed: row.devices_processed,
    errorMessage: row.error_message,
    triggeredBy: row.triggered_by,
    customRetentionDays: row.custom_retention_days,
    durationMs: row.finished_at ? row.finished_at - row.started_at : null
  }));
}

async function getDataStats() {
  const devices = await all('SELECT DISTINCT device_id FROM register_history UNION SELECT DISTINCT device_id FROM register_history_archive');
  
  const stats = [];
  
  for (const d of devices) {
    const deviceId = d.device_id;
    
    const hotRow = await get(`
      SELECT COUNT(*) as cnt 
      FROM register_history 
      WHERE device_id = ?
    `, [deviceId]);
    
    const coldRow = await get(`
      SELECT COUNT(*) as cnt 
      FROM register_history_archive 
      WHERE device_id = ?
    `, [deviceId]);
    
    const policy = await getPolicy(deviceId);
    
    stats.push({
      deviceId,
      hotRecords: hotRow ? hotRow.cnt : 0,
      archiveRecords: coldRow ? coldRow.cnt : 0,
      policy: {
        retentionDays: policy.retentionDays,
        granularity: policy.granularity,
        enabled: policy.enabled
      }
    });
  }
  
  return stats;
}

async function getRegisterHistoryWithArchive(deviceId, regAddress, startTime, endTime, intervalStr, limit) {
  const policy = await getPolicy(deviceId);
  const retentionMs = policy.retentionDays * 24 * 60 * 60 * 1000;
  const hotCutoff = Date.now() - retentionMs;

  let hotStartTime = startTime;
  let hotEndTime = endTime;
  let coldStartTime = startTime;
  let coldEndTime = endTime;

  const needHot = !endTime || endTime > hotCutoff;
  const needCold = !startTime || startTime < hotCutoff;

  let hotRows = [];
  let coldRows = [];

  if (needHot) {
    hotStartTime = startTime && startTime > hotCutoff ? startTime : hotCutoff;
    
    let sql = `
      SELECT value, timestamp, stale, 0 as is_archived
      FROM register_history
      WHERE device_id = ? AND reg_address = ? AND timestamp >= ?
    `;
    const params = [deviceId, regAddress, hotStartTime];

    if (hotEndTime) {
      sql += ' AND timestamp <= ?';
      params.push(hotEndTime);
    }
    sql += ' ORDER BY timestamp ASC';
    
    hotRows = await all(sql, params);
  }

  if (needCold) {
    coldEndTime = endTime && endTime < hotCutoff ? endTime : hotCutoff;
    
    let sql = `
      SELECT avg_value as value, timestamp, 0 as stale, 1 as is_archived, 
             max_value, min_value, sample_count
      FROM register_history_archive
      WHERE device_id = ? AND reg_address = ? AND timestamp < ?
    `;
    const params = [deviceId, regAddress, coldEndTime];

    if (coldStartTime) {
      sql += ' AND timestamp >= ?';
      params.push(coldStartTime);
    }
    sql += ' ORDER BY timestamp ASC';
    
    coldRows = await all(sql, params);
  }

  let combined = [...coldRows, ...hotRows];

  const intervalMs = parseIntervalMs(intervalStr);
  if (intervalMs && combined.length > 0) {
    combined = resampleData(combined, intervalMs);
  }

  if (limit) {
    const lim = Math.min(parseInt(limit) || 1000, 10000);
    if (combined.length > lim) {
      combined = combined.slice(-lim);
    }
  }

  return combined;
}

function parseIntervalMs(intervalStr) {
  if (!intervalStr) return null;
  const match = intervalStr.match(/^(\d+)(s|m|h)$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 3600 * 1000;
    default: return null;
  }
}

function resampleData(rows, intervalMs) {
  const result = [];
  let bucketStart = rows[0].timestamp;
  let bucketSum = 0;
  let bucketCount = 0;
  let bucketMax = -Infinity;
  let bucketMin = Infinity;
  let bucketArchived = false;

  for (const row of rows) {
    if (row.timestamp >= bucketStart + intervalMs) {
      if (bucketCount > 0) {
        result.push({
          value: bucketSum / bucketCount,
          timestamp: bucketStart,
          stale: 0,
          is_archived: bucketArchived ? 1 : 0,
          max_value: bucketMax,
          min_value: bucketMin,
          sample_count: bucketCount
        });
      }
      while (row.timestamp >= bucketStart + intervalMs) {
        bucketStart += intervalMs;
      }
      bucketSum = 0;
      bucketCount = 0;
      bucketMax = -Infinity;
      bucketMin = Infinity;
      bucketArchived = false;
    }
    bucketSum += row.value;
    bucketCount++;
    if (row.max_value !== undefined && row.max_value > bucketMax) bucketMax = row.max_value;
    else if (row.value > bucketMax) bucketMax = row.value;
    if (row.min_value !== undefined && row.min_value < bucketMin) bucketMin = row.min_value;
    else if (row.value < bucketMin) bucketMin = row.value;
    if (row.is_archived) bucketArchived = true;
  }

  if (bucketCount > 0) {
    result.push({
      value: bucketSum / bucketCount,
      timestamp: bucketStart,
      stale: 0,
      is_archived: bucketArchived ? 1 : 0,
      max_value: bucketMax,
      min_value: bucketMin,
      sample_count: bucketCount
    });
  }
  return result;
}

function startScheduledArchive() {
  if (archiveTimer) return;
  
  archiveTimer = setInterval(async () => {
    try {
      if (!isRunning) {
        console.log('[归档] 开始定时归档扫描...');
        const result = await runArchive({ triggeredBy: 'scheduled' });
        if (result.success) {
          console.log(`[归档] 定时归档完成: 归档${result.totalArchived}条聚合记录, 删除${result.totalDeleted}条原始记录, 处理${result.devicesProcessed}个设备`);
        }
      }
    } catch (e) {
      console.error('[归档] 定时归档出错:', e.message);
    }
  }, SCHEDULED_INTERVAL_MS);
  
  archiveTimer.unref();
  console.log('[归档] 定时归档已启动 (每小时执行一次)');
}

function stopScheduledArchive() {
  if (archiveTimer) {
    clearInterval(archiveTimer);
    archiveTimer = null;
    console.log('[归档] 定时归档已停止');
  }
}

function getStatus() {
  return {
    isRunning,
    scheduled: !!archiveTimer,
    scheduleIntervalMs: SCHEDULED_INTERVAL_MS
  };
}

module.exports = {
  getPolicy,
  getAllPolicies,
  setPolicy,
  deletePolicy,
  runArchive,
  getArchiveRuns,
  getDataStats,
  getRegisterHistoryWithArchive,
  startScheduledArchive,
  stopScheduledArchive,
  getStatus,
  parseGranularity,
  formatGranularity,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_GRANULARITY_SECONDS
};
