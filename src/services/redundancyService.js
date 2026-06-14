const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const redundancyStore = require('../store/redundancyStore');
const deviceStore = require('../store/deviceStore');
const pollingStore = require('../store/pollingStore');
const deviceService = require('./deviceService');

const SCAN_INTERVAL_MS = 2000;
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

const SWITCH_REASONS = {
  POLLING_FAILURE: 'polling_failure',
  MAINTENANCE_START: 'maintenance_start',
  UPGRADE_START: 'upgrade_start',
  MANUAL_OFFLINE: 'manual_offline',
  MANUAL_SWITCH: 'manual_switch',
  AUTO_FAILBACK: 'auto_failback',
  DEVICE_RECOVERED: 'device_recovered'
};

function validateCreateGroup(body) {
  if (!body.name || typeof body.name !== 'string') {
    return '主备组名称不能为空';
  }
  if (!body.primaryDeviceId || typeof body.primaryDeviceId !== 'string') {
    return '缺少主设备 primaryDeviceId';
  }
  if (!body.backupDeviceId || typeof body.backupDeviceId !== 'string') {
    return '缺少备用设备 backupDeviceId';
  }
  if (body.primaryDeviceId === body.backupDeviceId) {
    return '主设备和备用设备不能相同';
  }
  if (!deviceStore.hasDevice(body.primaryDeviceId)) {
    return '主设备不存在';
  }
  if (!deviceStore.hasDevice(body.backupDeviceId)) {
    return '备用设备不存在';
  }
  if (redundancyStore.isDeviceInRedundancy(body.primaryDeviceId)) {
    return '主设备已属于其他主备组';
  }
  if (redundancyStore.isDeviceInRedundancy(body.backupDeviceId)) {
    return '备用设备已属于其他主备组';
  }
  if (body.syncRegisters !== undefined && !Array.isArray(body.syncRegisters)) {
    return 'syncRegisters 必须是寄存器地址数组';
  }
  if (body.failbackDelaySeconds !== undefined &&
      (typeof body.failbackDelaySeconds !== 'number' || body.failbackDelaySeconds < 0)) {
    return 'failbackDelaySeconds 必须是非负整数';
  }
  return null;
}

function isDeviceAvailable(deviceId) {
  if (!deviceStore.hasDevice(deviceId)) return false;
  if (redundancyStore.isManualOffline(deviceId)) return false;

  const status = deviceStore.getStatus(deviceId);
  if (status === 'offline' || status === 'fault') return false;
  if (status === 'upgrading') return false;

  const maintenanceService = require('./maintenanceService');
  if (maintenanceService.isDeviceLocked(deviceId)) return false;

  const otaService = require('./otaService');
  if (otaService.isDeviceUpgrading(deviceId)) return false;

  return true;
}

function getDeviceAvailabilityDetail(deviceId) {
  if (!deviceStore.hasDevice(deviceId)) {
    return { available: false, reason: 'device_not_found' };
  }
  if (redundancyStore.isManualOffline(deviceId)) {
    return { available: false, reason: 'manual_offline' };
  }
  const status = deviceStore.getStatus(deviceId);
  if (status === 'offline') {
    return { available: false, reason: 'offline' };
  }
  if (status === 'fault') {
    return { available: false, reason: 'fault' };
  }
  if (status === 'upgrading') {
    return { available: false, reason: 'upgrading' };
  }
  const maintenanceService = require('./maintenanceService');
  if (maintenanceService.isDeviceLocked(deviceId)) {
    return { available: false, reason: 'maintenance' };
  }
  const otaService = require('./otaService');
  if (otaService.isDeviceUpgrading(deviceId)) {
    return { available: false, reason: 'upgrading' };
  }
  const pollingStatus = pollingStore.getStatus(deviceId);
  if (pollingStatus && pollingStatus.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
    return { available: false, reason: 'polling_failures' };
  }
  return { available: true, reason: null };
}

async function logSync(groupId, sourceId, targetId, address, oldValue, newValue, success = true, errorMsg = null) {
  try {
    await run(
      `INSERT INTO redundancy_sync_log (group_id, source_device_id, target_device_id, reg_address, old_value, new_value, status, error_message, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [groupId, sourceId, targetId, address, oldValue, newValue, success ? 'success' : 'failed', errorMsg, Date.now()]
    );
  } catch (e) {
    console.error('[冗余同步] 记录同步日志失败:', e.message);
  }
}

async function syncRegisterToBackup(groupId, primaryId, backupId, address, dataType, value) {
  try {
    const { value: oldValue } = deviceStore.getRegisterValue(backupId, address, dataType);
    const ok = deviceStore.setRegisterValue(backupId, address, dataType, value);
    if (ok) {
      await logSync(groupId, primaryId, backupId, address, oldValue, value, true);
      return true;
    } else {
      await logSync(groupId, primaryId, backupId, address, oldValue, value, false, 'write_failed');
      return false;
    }
  } catch (e) {
    await logSync(groupId, primaryId, backupId, address, value, value, false, e.message);
    return false;
  }
}

async function syncAllHotRegisters(groupId) {
  const group = redundancyStore.getGroup(groupId);
  if (!group) return;

  const currentPrimary = group.currentPrimaryId || group.current_primary_id;
  if (!currentPrimary) return;

  const peerId = redundancyStore.getPeerDeviceId(currentPrimary);
  if (!peerId || !isDeviceAvailable(peerId)) return;

  const syncRegisters = group.syncRegisters || [];
  if (syncRegisters.length === 0) return;

  const registers = await deviceService.getDeviceRegisters(currentPrimary);
  const regMap = new Map();
  for (const r of registers) {
    regMap.set(r.address, r);
  }

  for (const addr of syncRegisters) {
    const reg = regMap.get(addr);
    if (reg && reg.rw === 'RW') {
      const { value } = deviceStore.getRegisterValue(currentPrimary, addr, reg.data_type);
      await syncRegisterToBackup(groupId, currentPrimary, peerId, addr, reg.data_type, value);
    }
  }
}

async function logSwitchHistory(groupId, groupName, fromId, fromName, toId, toName,
                                reason, reasonDetail, triggeredBy, operatorRemark,
                                status, errorMessage, startedAt, completedAt) {
  try {
    await run(
      `INSERT INTO redundancy_switch_history (
        group_id, group_name, from_device_id, from_device_name,
        to_device_id, to_device_name, reason, reason_detail,
        triggered_by, operator_remark, status, error_message,
        started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        groupId, groupName, fromId || null, fromName || null,
        toId, toName, reason, reasonDetail || null,
        triggeredBy, operatorRemark || null, status, errorMessage || null,
        startedAt, completedAt || null
      ]
    );
  } catch (e) {
    console.error('[冗余切换] 记录切换历史失败:', e.message);
  }
}

async function getDeviceName(deviceId) {
  if (!deviceId) return null;
  try {
    const dev = await get('SELECT name FROM devices WHERE id = ?', [deviceId]);
    return dev ? dev.name : null;
  } catch (e) {
    return null;
  }
}

async function doSwitch(groupId, targetDeviceId, reason, reasonDetail, triggeredBy = 'system', operatorRemark = null) {
  const startedAt = Date.now();
  const group = redundancyStore.getGroup(groupId);
  if (!group) {
    return { success: false, error: '主备组不存在' };
  }

  const currentPrimary = group.currentPrimaryId || group.current_primary_id;
  if (currentPrimary === targetDeviceId) {
    return { success: false, error: '目标设备已是当前主机' };
  }

  const targetAvail = getDeviceAvailabilityDetail(targetDeviceId);
  if (!targetAvail.available) {
    const err = `目标设备不可接管: ${targetAvail.reason}`;
    const fromName = await getDeviceName(currentPrimary);
    const toName = await getDeviceName(targetDeviceId);
    await logSwitchHistory(groupId, group.name, currentPrimary, fromName, targetDeviceId, toName,
      reason, reasonDetail, triggeredBy, operatorRemark, 'failed', err, startedAt, Date.now());
    return { success: false, error: err };
  }

  try {
    const fromName = await getDeviceName(currentPrimary);
    const toName = await getDeviceName(targetDeviceId);

    await run(
      `UPDATE redundancy_groups SET current_primary_id = ?, status = 'normal', failover_count = failover_count + 1,
       last_switch_at = ?, last_switch_reason = ? WHERE id = ?`,
      [targetDeviceId, startedAt, reason, groupId]
    );

    redundancyStore.setCurrentPrimary(groupId, targetDeviceId);
    redundancyStore.setStatus(groupId, 'normal');
    redundancyStore.incrementFailoverCount(groupId);
    redundancyStore.setLastSwitch(groupId, reason);
    redundancyStore.clearFailbackTimer(groupId);

    if (currentPrimary) {
      const primaryAvail = getDeviceAvailabilityDetail(currentPrimary);
      if (!primaryAvail.available) {
        redundancyStore.setRecovered(groupId);
      } else {
        redundancyStore.clearRecovered(groupId);
      }
    }

    await syncAllHotRegisters(groupId);

    if (typeof switchCallback === 'function') {
      try {
        await switchCallback(groupId, currentPrimary, targetDeviceId);
      } catch (e) {
        console.error('[冗余切换] 通知回调失败:', e.message);
      }
    }

    await logSwitchHistory(groupId, group.name, currentPrimary, fromName, targetDeviceId, toName,
      reason, reasonDetail, triggeredBy, operatorRemark, 'success', null, startedAt, Date.now());

    console.log(`[冗余切换] 组[${group.name}] 切换成功: ${fromName || 'null'} -> ${toName}, 原因: ${reason}`);
    return { success: true, from: currentPrimary, to: targetDeviceId };

  } catch (e) {
    const fromName = await getDeviceName(currentPrimary);
    const toName = await getDeviceName(targetDeviceId);
    await logSwitchHistory(groupId, group.name, currentPrimary, fromName, targetDeviceId, toName,
      reason, reasonDetail, triggeredBy, operatorRemark, 'failed', e.message, startedAt, Date.now());
    console.error('[冗余切换] 切换失败:', e.message);
    return { success: false, error: e.message };
  }
}

async function enterDegradedMode(groupId, reason, reasonDetail) {
  const group = redundancyStore.getGroup(groupId);
  if (!group) return;

  await run(
    `UPDATE redundancy_groups SET status = 'degraded', last_switch_at = ?, last_switch_reason = ? WHERE id = ?`,
    [Date.now(), reason, groupId]
  );

  redundancyStore.setStatus(groupId, 'degraded');
  redundancyStore.setLastSwitch(groupId, reason);

  const toName = await getDeviceName(group.currentPrimaryId || group.current_primary_id);
  await logSwitchHistory(groupId, group.name,
    group.currentPrimaryId || group.current_primary_id, toName,
    null, null,
    reason + '_degraded', reasonDetail, 'system', null,
    'degraded', 'both_devices_unavailable', Date.now(), Date.now());

  console.log(`[冗余降级] 组[${group.name}] 进入降级状态: ${reason}`);
}

async function checkAndSwitchForDevice(deviceId, reason, reasonDetail) {
  const group = redundancyStore.getGroupByDevice(deviceId);
  if (!group) return null;

  const currentPrimary = group.currentPrimaryId || group.current_primary_id;
  if (deviceId !== currentPrimary) return null;

  const peerId = redundancyStore.getPeerDeviceId(deviceId);
  if (!peerId) return null;

  const peerAvail = getDeviceAvailabilityDetail(peerId);
  if (peerAvail.available) {
    return await doSwitch(group.id, peerId, reason, reasonDetail, 'system');
  } else {
    await enterDegradedMode(group.id, reason, reasonDetail);
    return { success: false, degraded: true, error: `备用设备不可用: ${peerAvail.reason}, 进入降级状态` };
  }
}

function scheduleFailback(groupId, delaySeconds) {
  const delayMs = Math.max(delaySeconds, 1) * 1000;
  const timer = setTimeout(async () => {
    try {
      const group = redundancyStore.getGroup(groupId);
      if (!group || group.status === 'degraded') return;

      const currentPrimary = group.currentPrimaryId || group.current_primary_id;
      const originalPrimary = group.primaryDeviceId || group.primary_device_id;

      if (currentPrimary === originalPrimary) return;
      if (!group.autoFailbackEnabled && group.auto_failback_enabled !== 1) return;

      const origAvail = getDeviceAvailabilityDetail(originalPrimary);
      if (!origAvail.available) {
        scheduleFailback(groupId, group.failbackDelaySeconds || group.failback_delay_seconds || 300);
        return;
      }

      const recoveredAt = group.recoveredAt || group.recovered_at;
      if (!recoveredAt) return;

      const stableMs = Date.now() - recoveredAt;
      const requiredMs = (group.failbackDelaySeconds || group.failback_delay_seconds || 300) * 1000;
      if (stableMs < requiredMs) {
        scheduleFailback(groupId, Math.ceil((requiredMs - stableMs) / 1000));
        return;
      }

      console.log(`[冗余回切] 组[${group.name}] 原主机稳定运行达到回切延迟，准备自动回切`);
      await doSwitch(groupId, originalPrimary, SWITCH_REASONS.AUTO_FAILBACK,
        `稳定运行${Math.floor(stableMs / 1000)}秒后自动回切`, 'system');

    } catch (e) {
      console.error('[冗余回切] 失败:', e.message);
    }
  }, delayMs);
  timer.unref();
  redundancyStore.setFailbackTimer(groupId, timer);
}

async function checkDeviceRecovery(deviceId) {
  const group = redundancyStore.getGroupByDevice(deviceId);
  if (!group) return;

  const currentPrimary = group.currentPrimaryId || group.current_primary_id;
  const originalPrimary = group.primaryDeviceId || group.primary_device_id;

  if (deviceId === originalPrimary && deviceId !== currentPrimary) {
    const avail = getDeviceAvailabilityDetail(deviceId);
    if (avail.available) {
      redundancyStore.setRecovered(group.id);
      if (group.status === 'degraded') {
        await doSwitch(group.id, deviceId, SWITCH_REASONS.DEVICE_RECOVERED, '设备恢复，退出降级状态', 'system');
      } else if (group.autoFailbackEnabled || group.auto_failback_enabled === 1) {
        const delay = group.failbackDelaySeconds || group.failback_delay_seconds || 300;
        console.log(`[冗余回切] 组[${group.name}] 原主机恢复，${delay}秒后自动回切`);
        scheduleFailback(group.id, delay);
      }
    }
  }

  const peerId = redundancyStore.getPeerDeviceId(deviceId);
  if (peerId) {
    const currentAvail = getDeviceAvailabilityDetail(currentPrimary);
    if (group.status === 'degraded' && currentAvail.available) {
      redundancyStore.setStatus(group.id, 'normal');
      await run(`UPDATE redundancy_groups SET status = 'normal' WHERE id = ?`, [group.id]);
      console.log(`[冗余] 组[${group.name}] 恢复正常状态`);
    }
  }
}

async function createGroup(body) {
  const err = validateCreateGroup(body);
  if (err) return { success: false, error: err, code: 400 };

  const id = uuidv4();
  const now = Date.now();
  const logicalDeviceId = body.logicalDeviceId || id;
  const syncRegisters = body.syncRegisters || [];
  const autoFailbackEnabled = body.autoFailbackEnabled !== undefined ? (body.autoFailbackEnabled ? 1 : 0) : 1;
  const failbackDelaySeconds = body.failbackDelaySeconds || 300;

  const primaryAvail = getDeviceAvailabilityDetail(body.primaryDeviceId);
  const initialPrimary = primaryAvail.available ? body.primaryDeviceId : body.backupDeviceId;

  await run(
    `INSERT INTO redundancy_groups (
      id, name, logical_device_id, primary_device_id, backup_device_id,
      current_primary_id, status, failover_count, auto_failback_enabled,
      failback_delay_seconds, sync_registers, description, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'normal', 0, ?, ?, ?, ?, ?)`,
    [
      id, body.name, logicalDeviceId, body.primaryDeviceId, body.backupDeviceId,
      initialPrimary, autoFailbackEnabled, failbackDelaySeconds,
      JSON.stringify(syncRegisters), body.description || null, now
    ]
  );

  await run(
    `INSERT INTO redundancy_device_bindings (device_id, group_id, role, created_at) VALUES (?, ?, 'primary', ?)`,
    [body.primaryDeviceId, id, now]
  );
  await run(
    `INSERT INTO redundancy_device_bindings (device_id, group_id, role, created_at) VALUES (?, ?, 'backup', ?)`,
    [body.backupDeviceId, id, now]
  );

  const group = {
    id,
    name: body.name,
    logicalDeviceId,
    primaryDeviceId: body.primaryDeviceId,
    backupDeviceId: body.backupDeviceId,
    currentPrimaryId: initialPrimary,
    status: 'normal',
    failoverCount: 0,
    autoFailbackEnabled: !!autoFailbackEnabled,
    failbackDelaySeconds,
    syncRegisters,
    description: body.description || null,
    createdAt: now
  };
  redundancyStore.addGroup(group);

  if (!primaryAvail.available) {
    const fromName = await getDeviceName(body.primaryDeviceId);
    const toName = await getDeviceName(body.backupDeviceId);
    await logSwitchHistory(id, body.name, body.primaryDeviceId, fromName, body.backupDeviceId, toName,
      'initial_setup', `启动时主设备不可用(${primaryAvail.reason})，初始选用备用机`, 'system', null,
      'success', null, now, now);
    console.log(`[冗余] 组[${body.name}] 创建时主设备不可用，初始选用备用机`);
  }

  await syncAllHotRegisters(id);

  return { success: true, group: await getGroupById(id) };
}

async function getGroupById(id) {
  const row = await get('SELECT * FROM redundancy_groups WHERE id = ?', [id]);
  if (!row) return null;
  return formatGroup(row);
}

function formatGroup(row) {
  const primaryId = row.primary_device_id;
  const backupId = row.backup_device_id;
  const currentId = row.current_primary_id;

  return {
    id: row.id,
    name: row.name,
    logicalDeviceId: row.logical_device_id,
    primaryDeviceId: primaryId,
    backupDeviceId: backupId,
    currentPrimaryId: currentId,
    peerDeviceId: currentId === primaryId ? backupId : primaryId,
    status: row.status,
    failoverCount: row.failover_count,
    autoFailbackEnabled: !!row.auto_failback_enabled,
    failbackDelaySeconds: row.failback_delay_seconds,
    syncRegisters: row.sync_registers ? JSON.parse(row.sync_registers) : [],
    description: row.description,
    createdAt: row.created_at,
    lastSwitchAt: row.last_switch_at,
    lastSwitchReason: row.last_switch_reason,
    primaryAvailable: getDeviceAvailabilityDetail(primaryId),
    backupAvailable: getDeviceAvailabilityDetail(backupId),
    recoveredAt: row.recovered_at
  };
}

async function getAllGroups() {
  const rows = await all('SELECT * FROM redundancy_groups ORDER BY created_at');
  return Promise.all(rows.map(formatGroup));
}

async function deleteGroup(id) {
  const row = await get('SELECT id FROM redundancy_groups WHERE id = ?', [id]);
  if (!row) return false;

  await run('DELETE FROM redundancy_groups WHERE id = ?', [id]);
  await run('DELETE FROM redundancy_device_bindings WHERE group_id = ?', [id]);
  redundancyStore.removeGroup(id);
  return true;
}

async function updateGroup(id, body) {
  const group = await get('SELECT * FROM redundancy_groups WHERE id = ?', [id]);
  if (!group) return { success: false, error: '主备组不存在', code: 404 };

  const updates = {};
  if (body.name !== undefined) {
    if (!body.name || typeof body.name !== 'string') {
      return { success: false, error: '名称不能为空', code: 400 };
    }
    updates.name = body.name;
  }
  if (body.description !== undefined) {
    updates.description = body.description;
  }
  if (body.autoFailbackEnabled !== undefined) {
    updates.auto_failback_enabled = body.autoFailbackEnabled ? 1 : 0;
  }
  if (body.failbackDelaySeconds !== undefined) {
    if (typeof body.failbackDelaySeconds !== 'number' || body.failbackDelaySeconds < 0) {
      return { success: false, error: 'failbackDelaySeconds 必须是非负整数', code: 400 };
    }
    updates.failback_delay_seconds = body.failbackDelaySeconds;
  }
  if (body.syncRegisters !== undefined) {
    if (!Array.isArray(body.syncRegisters)) {
      return { success: false, error: 'syncRegisters 必须是数组', code: 400 };
    }
    updates.sync_registers = JSON.stringify(body.syncRegisters);
    redundancyStore.updateSyncRegisters(id, body.syncRegisters);
  }

  if (Object.keys(updates).length === 0) {
    return { success: true, group: await getGroupById(id) };
  }

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const params = Object.values(updates);
  params.push(id);

  await run(`UPDATE redundancy_groups SET ${sets} WHERE id = ?`, params);

  const memGroup = redundancyStore.getGroup(id);
  if (memGroup) {
    if (updates.name !== undefined) memGroup.name = updates.name;
    if (updates.auto_failback_enabled !== undefined) {
      memGroup.autoFailbackEnabled = !!updates.auto_failback_enabled;
      memGroup.auto_failback_enabled = updates.auto_failback_enabled;
    }
    if (updates.failback_delay_seconds !== undefined) {
      memGroup.failbackDelaySeconds = updates.failback_delay_seconds;
      memGroup.failback_delay_seconds = updates.failback_delay_seconds;
    }
  }

  return { success: true, group: await getGroupById(id) };
}

async function manualSwitch(groupId, targetDeviceId, operatorRemark) {
  const group = redundancyStore.getGroup(groupId);
  if (!group) return { success: false, error: '主备组不存在', code: 404 };

  const primaryId = group.primaryDeviceId || group.primary_device_id;
  const backupId = group.backupDeviceId || group.backup_device_id;
  if (targetDeviceId !== primaryId && targetDeviceId !== backupId) {
    return { success: false, error: '目标设备不属于该主备组', code: 400 };
  }

  return await doSwitch(groupId, targetDeviceId, SWITCH_REASONS.MANUAL_SWITCH,
    '人工主动切换', 'manual', operatorRemark);
}

async function setDeviceOffline(deviceId, offline, reason) {
  if (!deviceStore.hasDevice(deviceId)) {
    return { success: false, error: '设备不存在', code: 404 };
  }

  redundancyStore.setManualOffline(deviceId, offline);

  if (offline) {
    const result = await checkAndSwitchForDevice(deviceId, SWITCH_REASONS.MANUAL_OFFLINE,
      reason || '人工下线');
    if (result) return result;
  } else {
    await checkDeviceRecovery(deviceId);
  }

  return { success: true };
}

async function getSwitchHistory(groupId, limit = 100) {
  const n = Math.min(Math.max(parseInt(limit) || 100, 1), 1000);
  let sql = 'SELECT * FROM redundancy_switch_history';
  const params = [];
  if (groupId) {
    sql += ' WHERE group_id = ?';
    params.push(groupId);
  }
  sql += ' ORDER BY started_at DESC LIMIT ?';
  params.push(n);

  const rows = await all(sql, params);
  return rows.map(r => ({
    id: r.id,
    groupId: r.group_id,
    groupName: r.group_name,
    fromDeviceId: r.from_device_id,
    fromDeviceName: r.from_device_name,
    toDeviceId: r.to_device_id,
    toDeviceName: r.to_device_name,
    reason: r.reason,
    reasonDetail: r.reason_detail,
    triggeredBy: r.triggered_by,
    operatorRemark: r.operator_remark,
    status: r.status,
    errorMessage: r.error_message,
    startedAt: r.started_at,
    completedAt: r.completed_at
  }));
}

async function getSyncLogs(groupId, limit = 100) {
  const n = Math.min(Math.max(parseInt(limit) || 100, 1), 1000);
  let sql = 'SELECT * FROM redundancy_sync_log';
  const params = [];
  if (groupId) {
    sql += ' WHERE group_id = ?';
    params.push(groupId);
  }
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(n);

  const rows = await all(sql, params);
  return rows.map(r => ({
    id: r.id,
    groupId: r.group_id,
    sourceDeviceId: r.source_device_id,
    targetDeviceId: r.target_device_id,
    regAddress: r.reg_address,
    oldValue: r.old_value,
    newValue: r.new_value,
    status: r.status,
    errorMessage: r.error_message,
    timestamp: r.timestamp
  }));
}

function resolveDeviceForOperation(deviceId) {
  const group = redundancyStore.getGroupByDevice(deviceId);
  if (!group) return { deviceId, isRedundancy: false, inDegraded: false };

  const currentPrimary = group.currentPrimaryId || group.current_primary_id;
  const inDegraded = group.status === 'degraded';

  if (inDegraded && !currentPrimary) {
    return { deviceId, isRedundancy: true, inDegraded: true, groupId: group.id, groupName: group.name };
  }

  return {
    deviceId: currentPrimary || deviceId,
    isRedundancy: true,
    inDegraded: false,
    groupId: group.id,
    groupName: group.name,
    backupDeviceId: redundancyStore.getPeerDeviceId(currentPrimary)
  };
}

async function notifyRegisterWritten(deviceId, address, dataType, value) {
  const group = redundancyStore.getGroupByDevice(deviceId);
  if (!group) return;

  const currentPrimary = group.currentPrimaryId || group.current_primary_id;
  if (deviceId !== currentPrimary) return;

  const syncRegisters = group.syncRegisters || [];
  if (!syncRegisters.includes(address)) return;

  const backupId = redundancyStore.getPeerDeviceId(deviceId);
  if (!backupId || !isDeviceAvailable(backupId)) return;

  await syncRegisterToBackup(group.id, deviceId, backupId, address, dataType, value);
}

async function scanOnce() {
  const groups = redundancyStore.getAllGroups();
  for (const group of groups) {
    try {
      const currentPrimary = group.currentPrimaryId || group.current_primary_id;
      if (!currentPrimary) continue;

      const currentAvail = getDeviceAvailabilityDetail(currentPrimary);

      if (!currentAvail.available) {
        const peerId = redundancyStore.getPeerDeviceId(currentPrimary);
        if (peerId) {
          const peerAvail = getDeviceAvailabilityDetail(peerId);
          if (peerAvail.available) {
            console.log(`[冗余扫描] 组[${group.name}] 当前主机不可用(${currentAvail.reason})，准备切换`);
            await doSwitch(group.id, peerId, SWITCH_REASONS.POLLING_FAILURE,
              `扫描检测到主机不可用: ${currentAvail.reason}`, 'system');
          } else if (group.status !== 'degraded') {
            await enterDegradedMode(group.id, SWITCH_REASONS.POLLING_FAILURE,
              `扫描检测到主机不可用(${currentAvail.reason})且备用机也不可用(${peerAvail.reason})`);
          }
        }
      } else {
        const primaryId = group.primaryDeviceId || group.primary_device_id;
        const backupId = group.backupDeviceId || group.backup_device_id;

        if (currentPrimary === backupId && group.status !== 'degraded') {
          const origAvail = getDeviceAvailabilityDetail(primaryId);
          if (origAvail.available) {
            checkDeviceRecovery(primaryId);
          }
        }

        const peerId = redundancyStore.getPeerDeviceId(currentPrimary);
        if (peerId && isDeviceAvailable(peerId)) {
          const syncRegisters = group.syncRegisters || [];
          if (syncRegisters.length > 0) {
            const registers = await deviceService.getDeviceRegisters(currentPrimary);
            const regMap = new Map();
            for (const r of registers) {
              regMap.set(r.address, r);
            }
            for (const addr of syncRegisters) {
              const reg = regMap.get(addr);
              if (reg && reg.rw === 'RW') {
                const { value: primaryVal, stale: primaryStale } = deviceStore.getRegisterValue(currentPrimary, addr, reg.data_type);
                const { value: backupVal } = deviceStore.getRegisterValue(peerId, addr, reg.data_type);
                if (!primaryStale && Math.abs(primaryVal - backupVal) > 1e-6) {
                  await syncRegisterToBackup(group.id, currentPrimary, peerId, addr, reg.data_type, primaryVal);
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.error(`[冗余扫描] 组[${group.name}] 处理异常:`, e.message);
    }
  }
}

let scanTimer = null;
let switchCallback = null;

function setSwitchCallback(cb) {
  switchCallback = cb;
}

function initFromDB() {
  return loadGroupsFromDB();
}

function startEngine() {
  if (scanTimer) return;
  scanTimer = setInterval(() => {
    scanOnce().catch(e => console.error('[冗余扫描] 错误:', e));
  }, SCAN_INTERVAL_MS);
  redundancyStore.setScanTimer(scanTimer);
  console.log(`冗余引擎已启动 (扫描间隔 ${SCAN_INTERVAL_MS}ms)`);
}

function stopEngine() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  redundancyStore.clearAllTimers();
}

async function loadGroupsFromDB() {
  const rows = await all('SELECT * FROM redundancy_groups');
  for (const row of rows) {
    const group = {
      id: row.id,
      name: row.name,
      logicalDeviceId: row.logical_device_id,
      primaryDeviceId: row.primary_device_id,
      backupDeviceId: row.backup_device_id,
      currentPrimaryId: row.current_primary_id,
      status: row.status,
      failoverCount: row.failover_count,
      autoFailbackEnabled: !!row.auto_failback_enabled,
      auto_failback_enabled: row.auto_failback_enabled,
      failbackDelaySeconds: row.failback_delay_seconds,
      failback_delay_seconds: row.failback_delay_seconds,
      syncRegisters: row.sync_registers ? JSON.parse(row.sync_registers) : [],
      description: row.description,
      createdAt: row.created_at,
      lastSwitchAt: row.last_switch_at,
      last_switch_at: row.last_switch_at,
      lastSwitchReason: row.last_switch_reason,
      last_switch_reason: row.last_switch_reason,
      recoveredAt: row.recovered_at,
      recovered_at: row.recovered_at
    };
    redundancyStore.addGroup(group);
  }
  console.log(`从数据库恢复 ${rows.length} 个主备冗余组`);
  return rows.length;
}

module.exports = {
  createGroup,
  getGroupById,
  getAllGroups,
  updateGroup,
  deleteGroup,
  manualSwitch,
  setDeviceOffline,
  getSwitchHistory,
  getSyncLogs,
  resolveDeviceForOperation,
  notifyRegisterWritten,
  checkAndSwitchForDevice,
  checkDeviceRecovery,
  isDeviceAvailable,
  getDeviceAvailabilityDetail,
  loadGroupsFromDB,
  initFromDB,
  setSwitchCallback,
  startEngine,
  stopEngine,
  scanOnce,
  syncAllHotRegisters,
  SWITCH_REASONS,
  CONSECUTIVE_FAILURE_THRESHOLD
};
