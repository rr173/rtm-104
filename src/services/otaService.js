const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const otaStore = require('../store/otaStore');
const deviceStore = require('../store/deviceStore');
const pollingStore = require('../store/pollingStore');
const firmwareService = require('./firmwareService');

const STAGES = [
  { name: 'download', label: '下载', duration: 2000, progressStart: 0, progressEnd: 25 },
  { name: 'verify', label: '校验', duration: 2000, progressStart: 25, progressEnd: 50 },
  { name: 'install', label: '安装', duration: 2000, progressStart: 50, progressEnd: 75 },
  { name: 'reboot', label: '重启', duration: 2000, progressStart: 75, progressEnd: 100 }
];

const FAILURE_PROBABILITY = 0.05;

function shouldFail() {
  return Math.random() < FAILURE_PROBABILITY;
}

function getProgressForStage(stageIndex, elapsed, totalDuration) {
  const stage = STAGES[stageIndex];
  const ratio = Math.min(elapsed / totalDuration, 1);
  return Math.floor(stage.progressStart + (stage.progressEnd - stage.progressStart) * ratio);
}

async function loadOtaHistoryFromDB() {
  const rows = await all('SELECT * FROM ota_upgrades ORDER BY started_at DESC');
  return rows.length;
}

async function startUpgrade(deviceId, firmwareId) {
  if (!deviceStore.hasDevice(deviceId)) {
    return { success: false, error: '设备不存在' };
  }

  if (otaStore.hasActiveUpgrade(deviceId)) {
    return { success: false, error: '该设备已有正在进行的升级任务' };
  }

  const firmware = await firmwareService.getFirmwareById(firmwareId);
  if (!firmware) {
    return { success: false, error: '固件版本不存在' };
  }

  const currentVersion = deviceStore.getFirmwareVersion(deviceId);
  if (currentVersion === firmware.version) {
    return { success: false, error: '设备当前版本已是该固件版本' };
  }

  const upgradeId = uuidv4();
  const now = Date.now();

  await run(
    `INSERT INTO ota_upgrades (id, device_id, firmware_id, firmware_version, status, stage, progress, started_at)
     VALUES (?, ?, ?, ?, 'upgrading', 'download', 0, ?)`,
    [upgradeId, deviceId, firmwareId, firmware.version, now]
  );

  otaStore.startUpgrade(deviceId, upgradeId, firmwareId, firmware.version);

  deviceStore.setStatus(deviceId, 'upgrading');
  pollingStore.clearTimer(deviceId);

  runUpgradeStages(deviceId, upgradeId, firmwareId, firmware.version, 0);

  return {
    success: true,
    upgrade: {
      id: upgradeId,
      deviceId,
      firmwareId,
      firmwareVersion: firmware.version,
      status: 'upgrading',
      stage: 'download',
      progress: 0,
      startedAt: now
    }
  };
}

function runUpgradeStages(deviceId, upgradeId, firmwareId, firmwareVersion, stageIndex) {
  if (stageIndex >= STAGES.length) {
    completeUpgrade(deviceId, upgradeId, firmwareVersion);
    return;
  }

  const stage = STAGES[stageIndex];
  otaStore.updateStage(deviceId, stage.name, stage.progressStart);

  run(
    `UPDATE ota_upgrades SET stage = ?, progress = ? WHERE id = ?`,
    [stage.name, stage.progressStart, upgradeId]
  );

  const startTime = Date.now();
  const progressInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const progress = getProgressForStage(stageIndex, elapsed, stage.duration);
    otaStore.updateStage(deviceId, stage.name, progress);
    run(
      `UPDATE ota_upgrades SET progress = ? WHERE id = ?`,
      [progress, upgradeId]
    );
  }, 200);

  const stageTimer = setTimeout(() => {
    clearInterval(progressInterval);

    if (shouldFail()) {
      const errorMsg = `${stage.label}阶段失败，随机模拟故障`;
      failUpgrade(deviceId, upgradeId, stage.name, errorMsg);
      return;
    }

    otaStore.updateStage(deviceId, stage.name, stage.progressEnd);
    run(
      `UPDATE ota_upgrades SET progress = ? WHERE id = ?`,
      [stage.progressEnd, upgradeId]
    );

    runUpgradeStages(deviceId, upgradeId, firmwareId, firmwareVersion, stageIndex + 1);
  }, stage.duration);

  stageTimer.unref();
  otaStore.setStageTimer(deviceId, stageTimer);
}

async function completeUpgrade(deviceId, upgradeId, firmwareVersion) {
  const now = Date.now();

  await run(
    `UPDATE ota_upgrades SET status = 'success', stage = 'completed', progress = 100, finished_at = ? WHERE id = ?`,
    [now, upgradeId]
  );

  await run(
    `UPDATE devices SET firmware_version = ? WHERE id = ?`,
    [firmwareVersion, deviceId]
  );

  deviceStore.setFirmwareVersion(deviceId, firmwareVersion);
  deviceStore.setStatus(deviceId, 'online');
  otaStore.completeUpgrade(deviceId);

  try {
    const pollingService = require('./pollingService');
    const config = await pollingService.getConfig(deviceId);
    if (config && config.enabled) {
      await pollingService.setPollingConfig(config);
    }
  } catch (e) {
    console.error('恢复轮询失败:', e.message);
  }
}

async function failUpgrade(deviceId, upgradeId, stage, errorMessage) {
  const now = Date.now();

  await run(
    `UPDATE ota_upgrades SET status = 'failed', stage = ?, error_message = ?, finished_at = ? WHERE id = ?`,
    [stage, errorMessage, now, upgradeId]
  );

  deviceStore.setStatus(deviceId, 'online');
  otaStore.failUpgrade(deviceId, errorMessage);

  try {
    const pollingService = require('./pollingService');
    const config = await pollingService.getConfig(deviceId);
    if (config && config.enabled) {
      await pollingService.setPollingConfig(config);
    }
  } catch (e) {
    console.error('恢复轮询失败:', e.message);
  }
}

function getUpgradeProgress(deviceId) {
  const active = otaStore.getActiveUpgrade(deviceId);
  if (active) {
    return {
      id: active.upgradeId,
      deviceId: active.deviceId,
      firmwareId: active.firmwareId,
      firmwareVersion: active.firmwareVersion,
      status: 'upgrading',
      stage: active.stage,
      stageLabel: getStageLabel(active.stage),
      progress: active.progress,
      startedAt: active.startedAt
    };
  }
  return null;
}

function getStageLabel(stageName) {
  const stage = STAGES.find(s => s.name === stageName);
  return stage ? stage.label : stageName;
}

async function getUpgradeHistory(deviceId, limit = 50) {
  let sql = 'SELECT * FROM ota_upgrades';
  const params = [];

  if (deviceId) {
    sql += ' WHERE device_id = ?';
    params.push(deviceId);
  }

  sql += ' ORDER BY started_at DESC LIMIT ?';
  params.push(limit);

  const rows = await all(sql, params);
  return rows.map(row => ({
    id: row.id,
    deviceId: row.device_id,
    firmwareId: row.firmware_id,
    firmwareVersion: row.firmware_version,
    status: row.status,
    stage: row.stage,
    stageLabel: row.stage ? getStageLabel(row.stage) : null,
    progress: row.progress,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }));
}

async function getUpgradeById(upgradeId) {
  const row = await get('SELECT * FROM ota_upgrades WHERE id = ?', [upgradeId]);
  if (!row) return null;

  return {
    id: row.id,
    deviceId: row.device_id,
    firmwareId: row.firmware_id,
    firmwareVersion: row.firmware_version,
    status: row.status,
    stage: row.stage,
    stageLabel: row.stage ? getStageLabel(row.stage) : null,
    progress: row.progress,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function isDeviceUpgrading(deviceId) {
  return otaStore.hasActiveUpgrade(deviceId);
}

module.exports = {
  loadOtaHistoryFromDB,
  startUpgrade,
  getUpgradeProgress,
  getUpgradeHistory,
  getUpgradeById,
  isDeviceUpgrading,
  STAGES
};
