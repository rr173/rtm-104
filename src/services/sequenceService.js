const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const sequenceStore = require('../store/sequenceStore');
const interlockStore = require('../store/interlockStore');
const maintenanceService = require('./maintenanceService');
const redundancyService = require('./redundancyService');
const { evaluateExpression, parseExpression, getReferences } = require('../utils/expression');

const SCAN_INTERVAL_MS = 200;

function toBool(v) {
  if (typeof v === 'boolean') return v;
  return v !== 0;
}

function resolveRegisterReference(refName) {
  const parts = refName.split('.');
  if (parts.length < 2) return 0;
  const origDeviceId = parts[0];
  const regStr = parts[1];
  const addrMatch = regStr.match(/^reg(\d+)$/);
  if (!addrMatch) return 0;
  const address = parseInt(addrMatch[1]);
  const resolved = redundancyService.resolveDeviceForOperation(origDeviceId);
  const deviceId = resolved.deviceId;
  const { value } = deviceStore.getRegisterValue(deviceId, address, 'float32');
  return value;
}

function isRegisterOverriddenByInterlock(deviceId, address, expectedValue, sinceTimestamp) {
  const active = interlockStore.getActiveWrite(deviceId, address);
  if (!active) return false;
  if (sinceTimestamp !== undefined && active.timestamp < sinceTimestamp) return false;
  const { value } = deviceStore.getRegisterValue(deviceId, address, 'float32');
  return Math.abs(value - expectedValue) > 1e-6;
}

async function createSequence(data) {
  if (!data.name || typeof data.name !== 'string') {
    return { success: false, error: '名称不能为空' };
  }
  if (!Array.isArray(data.steps) || data.steps.length === 0) {
    return { success: false, error: '步骤列表不能为空' };
  }

  const stepNumbers = new Set();
  for (const step of data.steps) {
    if (typeof step.stepNumber !== 'number' || step.stepNumber < 1) {
      return { success: false, error: '步骤号必须是大于等于1的整数' };
    }
    if (stepNumbers.has(step.stepNumber)) {
      return { success: false, error: `步骤号重复: ${step.stepNumber}` };
    }
    stepNumbers.add(step.stepNumber);

    if (!Array.isArray(step.actions)) {
      return { success: false, error: `步骤${step.stepNumber}: 动作列表不能为空` };
    }
    for (const a of step.actions) {
      if (!a.deviceId || typeof a.address !== 'number' || typeof a.value !== 'number') {
        return { success: false, error: `步骤${step.stepNumber}: 每个动作必须包含 deviceId, address, value` };
      }
    }

    if (!step.transitionCondition || typeof step.transitionCondition !== 'string') {
      return { success: false, error: `步骤${step.stepNumber}: 转移条件不能为空` };
    }
    try {
      parseExpression(step.transitionCondition);
    } catch (e) {
      return { success: false, error: `步骤${step.stepNumber}: 转移条件解析失败: ${e.message}` };
    }

    if (step.timeoutSeconds !== undefined && typeof step.timeoutSeconds !== 'number') {
      return { success: false, error: `步骤${step.stepNumber}: 超时秒数必须是数字` };
    }
    if (step.timeoutTarget !== undefined && step.timeoutTarget !== 'abort' &&
        typeof step.timeoutTarget !== 'number') {
      return { success: false, error: `步骤${step.stepNumber}: 超时跳转目标必须是步骤号或"abort"` };
    }
  }

  const id = uuidv4();
  const now = Date.now();

  await run(
    'INSERT INTO sequences (id, name, steps, created_at) VALUES (?, ?, ?, ?)',
    [id, data.name, JSON.stringify(data.steps), now]
  );

  return { success: true, sequence: await getSequenceById(id) };
}

async function getSequenceById(id) {
  const row = await get('SELECT * FROM sequences WHERE id = ?', [id]);
  if (!row) return null;
  return formatSequence(row);
}

function formatSequence(row) {
  return {
    id: row.id,
    name: row.name,
    steps: JSON.parse(row.steps),
    createdAt: row.created_at
  };
}

async function getAllSequences() {
  const rows = await all('SELECT * FROM sequences ORDER BY created_at');
  return rows.map(formatSequence);
}

async function deleteSequence(id) {
  const row = await get('SELECT id FROM sequences WHERE id = ?', [id]);
  if (!row) return false;
  await run('DELETE FROM sequences WHERE id = ?', [id]);
  return true;
}

async function startSequence(id) {
  const row = await get('SELECT * FROM sequences WHERE id = ?', [id]);
  if (!row) return { success: false, error: '顺序程序不存在', code: 404 };

  if (sequenceStore.isRunning()) {
    return { success: false, error: '已有顺序程序正在执行', code: 409 };
  }

  const steps = JSON.parse(row.steps);
  sequenceStore.startExecution(row.id, row.name, steps);

  const firstStepNum = sequenceStore.currentExecution.stepNumbers[0];
  await enterAndExecuteStep(firstStepNum);

  return { success: true, status: getSequenceStatus(id) };
}

async function enterAndExecuteStep(stepNumber) {
  const exec = sequenceStore.getExecution();
  if (!exec) return;

  const step = exec.steps[stepNumber];
  if (!step) return;

  sequenceStore.enterStep(stepNumber);

  let hasLockedDevice = false;
  let lockedDeviceId = null;
  const resolvedActions = [];
  for (const action of step.actions) {
    const resolved = redundancyService.resolveDeviceForOperation(action.deviceId);
    const actualDeviceId = resolved.deviceId;
    if (resolved.inDegraded) {
      hasLockedDevice = true;
      lockedDeviceId = action.deviceId;
      sequenceStore.markStepBlocked(stepNumber, `主备组[${resolved.groupName}]降级，无可用设备`);
      console.log(`[顺序控制] 步骤${stepNumber}因主备组降级被阻塞: sequenceId=${exec.sequenceId}`);
      return;
    }
    if (maintenanceService.isDeviceLocked(actualDeviceId)) {
      hasLockedDevice = true;
      lockedDeviceId = actualDeviceId;
      break;
    }
    resolvedActions.push({ ...action, deviceId: actualDeviceId, originalDeviceId: action.deviceId });
  }

  if (hasLockedDevice) {
    sequenceStore.markStepBlocked(stepNumber, `设备${lockedDeviceId}维保中`);
    maintenanceService.logBlockedSequence(
      lockedDeviceId, exec.sequenceId, stepNumber
    ).catch(e => console.error('记录顺序阻塞事件失败:', e));
    console.log(`[顺序控制] 步骤${stepNumber}因设备维保被阻塞: sequenceId=${exec.sequenceId}, deviceId=${lockedDeviceId}`);
    return;
  }

  for (const action of resolvedActions) {
    deviceStore.setRegisterValue(action.deviceId, action.address, 'float32', action.value);
    try {
      await redundancyService.notifyRegisterWritten(action.deviceId, action.address, 'float32', action.value);
    } catch (e) {
      console.error('[顺序控制] 热同步备用机失败:', e.message);
    }
  }
}

function checkStepOverrides() {
  const exec = sequenceStore.getExecution();
  if (!exec || exec.currentStep === null) return;

  const step = exec.steps[exec.currentStep];
  if (!step) return;

  const history = exec.stepHistory[exec.currentStep];
  const enteredAt = history ? history.enteredAt : exec.startedAt;

  for (const action of step.actions) {
    if (isRegisterOverriddenByInterlock(action.deviceId, action.address, action.value, enteredAt)) {
      sequenceStore.markStepOverridden(exec.currentStep);
      break;
    }
  }
}

async function checkBlockedStepResume() {
  const exec = sequenceStore.getExecution();
  if (!exec || exec.status !== 'blocked' || exec.currentStep === null) return;

  const step = exec.steps[exec.currentStep];
  if (!step) return;

  let hasLockedDevice = false;
  for (const action of step.actions) {
    const resolved = redundancyService.resolveDeviceForOperation(action.deviceId);
    const actualDeviceId = resolved.deviceId;
    if (resolved.inDegraded) {
      hasLockedDevice = true;
      break;
    }
    if (maintenanceService.isDeviceLocked(actualDeviceId)) {
      hasLockedDevice = true;
      break;
    }
  }

  if (!hasLockedDevice) {
    sequenceStore.unblock();
    const stepHist = exec.stepHistory[exec.currentStep];
    if (stepHist && stepHist.blockedAt) {
      stepHist.unblockedAt = Date.now();
      stepHist.blocked = false;
    }
    console.log(`[顺序控制] 步骤${exec.currentStep}设备维保结束，恢复执行: sequenceId=${exec.sequenceId}`);

    for (const action of step.actions) {
      const resolved = redundancyService.resolveDeviceForOperation(action.deviceId);
      const actualDeviceId = resolved.deviceId;
      deviceStore.setRegisterValue(actualDeviceId, action.address, 'float32', action.value);
      try {
        await redundancyService.notifyRegisterWritten(actualDeviceId, action.address, 'float32', action.value);
      } catch (e) {
        console.error('[顺序控制] 恢复时热同步备用机失败:', e.message);
      }
    }
  }
}

async function checkTransitions() {
  const exec = sequenceStore.getExecution();
  if (!exec) return;

  if (exec.status === 'blocked') {
    await checkBlockedStepResume();
    if (exec.status === 'blocked') {
      return;
    }
  }

  if (exec.status !== 'running' && exec.status !== 'overridden') return;

  checkStepOverrides();

  const step = exec.steps[exec.currentStep];
  if (!step) return;

  const history = exec.stepHistory[exec.currentStep];
  const enteredAt = history ? history.enteredAt : exec.startedAt;
  const blockedMs = history ? (history.blockedMs || 0) : 0;
  const elapsedSec = (Date.now() - enteredAt - blockedMs) / 1000;

  if (step.timeoutSeconds !== undefined && elapsedSec >= step.timeoutSeconds) {
    sequenceStore.leaveStep(exec.currentStep);
    if (step.timeoutTarget === 'abort' || step.timeoutTarget === undefined) {
      sequenceStore.setStatus('timeout');
      return;
    }
    const targetStep = step.timeoutTarget;
    if (!exec.steps[targetStep]) {
      sequenceStore.setStatus('timeout');
      return;
    }
    await enterAndExecuteStep(targetStep);
    return;
  }

  let condValue;
  try {
    condValue = evaluateExpression(step.transitionCondition, resolveRegisterReference);
  } catch (e) {
    return;
  }

  if (toBool(condValue)) {
    sequenceStore.leaveStep(exec.currentStep);
    const currentIdx = exec.stepNumbers.indexOf(exec.currentStep);
    if (currentIdx >= exec.stepNumbers.length - 1) {
      sequenceStore.setStatus('completed');
    } else {
      const nextStep = exec.stepNumbers[currentIdx + 1];
      await enterAndExecuteStep(nextStep);
    }
  }
}

function stopSequence(id) {
  const exec = sequenceStore.getExecution();
  if (!exec) return { success: false, error: '没有正在执行的程序', code: 404 };
  if (exec.sequenceId !== id) {
    return { success: false, error: '当前执行的程序ID不匹配', code: 400 };
  }
  if (exec.currentStep !== null) {
    sequenceStore.leaveStep(exec.currentStep);
  }
  sequenceStore.setStatus('aborted');
  return { success: true, status: getSequenceStatus(id) };
}

function getSequenceStatus(id) {
  const exec = sequenceStore.getExecution();
  if (!exec || exec.sequenceId !== id) {
    return {
      id,
      status: 'idle',
      currentStep: null,
      elapsedMs: 0,
      stepHistory: {},
      overridden: false,
      blocked: false
    };
  }
  return {
    id: exec.sequenceId,
    name: exec.sequenceName,
    status: exec.status,
    currentStep: exec.currentStep,
    startedAt: exec.startedAt,
    elapsedMs: Date.now() - exec.startedAt,
    stepHistory: exec.stepHistory,
    overridden: exec.overridden,
    blocked: exec.blocked || false,
    blockedSince: exec.blockedSince || null,
    blockedReason: exec.blockedReason || null
  };
}

let scanTimer = null;

function startEngine() {
  if (scanTimer) return;
  scanTimer = setInterval(() => {
    checkTransitions().catch(e => console.error('顺序控制扫描错误:', e));
  }, SCAN_INTERVAL_MS);
  console.log(`顺序控制引擎已启动 (扫描间隔 ${SCAN_INTERVAL_MS}ms)`);
}

function stopEngine() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

module.exports = {
  createSequence,
  getSequenceById,
  getAllSequences,
  deleteSequence,
  startSequence,
  stopSequence,
  getSequenceStatus,
  startEngine,
  stopEngine
};
