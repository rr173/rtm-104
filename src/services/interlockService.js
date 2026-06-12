const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const interlockStore = require('../store/interlockStore');
const maintenanceService = require('./maintenanceService');
const { evaluateExpression, parseExpression, getReferences } = require('../utils/expression');

const SCAN_INTERVAL_MS = 500;

function toBool(v) {
  if (typeof v === 'boolean') return v;
  return v !== 0;
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

async function createInterlock(data) {
  if (!data.name || typeof data.name !== 'string') {
    return { success: false, error: '名称不能为空' };
  }
  if (!data.condition || typeof data.condition !== 'string') {
    return { success: false, error: '条件表达式不能为空' };
  }
  try {
    parseExpression(data.condition);
  } catch (e) {
    return { success: false, error: '条件表达式解析失败: ' + e.message };
  }
  if (!Array.isArray(data.actions) || data.actions.length === 0) {
    return { success: false, error: '保护动作列表不能为空' };
  }
  for (const a of data.actions) {
    if (!a.deviceId || typeof a.address !== 'number' || typeof a.value !== 'number') {
      return { success: false, error: '每个动作必须包含 deviceId, address, value' };
    }
  }
  const priority = typeof data.priority === 'number' ? data.priority : 3;
  if (priority < 1 || priority > 5) {
    return { success: false, error: '优先级必须在1-5之间' };
  }
  const enabled = data.enabled === undefined ? true : !!data.enabled;
  const autoReset = data.autoReset === undefined ? false : !!data.autoReset;

  const id = uuidv4();
  const now = Date.now();

  await run(
    'INSERT INTO interlocks (id, name, condition, actions, priority, enabled, auto_reset, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, data.name, data.condition, JSON.stringify(data.actions), priority, enabled ? 1 : 0, autoReset ? 1 : 0, now]
  );

  interlockStore.setState(id, enabled ? 'normal' : 'disabled');

  return { success: true, interlock: await getInterlockById(id) };
}

async function getInterlockById(id) {
  const row = await get('SELECT * FROM interlocks WHERE id = ?', [id]);
  if (!row) return null;
  return formatInterlock(row);
}

function formatInterlock(row) {
  const state = interlockStore.getState(row.id);
  const info = interlockStore.getTriggeredInfo(row.id);
  return {
    id: row.id,
    name: row.name,
    condition: row.condition,
    actions: JSON.parse(row.actions),
    priority: row.priority,
    enabled: !!row.enabled,
    autoReset: !!row.auto_reset,
    createdAt: row.created_at,
    status: state,
    triggeredInfo: info
  };
}

async function getAllInterlocks() {
  const rows = await all('SELECT * FROM interlocks ORDER BY created_at');
  return rows.map(formatInterlock);
}

async function updateInterlock(id, data) {
  const existing = await get('SELECT * FROM interlocks WHERE id = ?', [id]);
  if (!existing) return { success: false, error: '联锁规则不存在' };

  const updates = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.condition !== undefined) {
    try {
      parseExpression(data.condition);
    } catch (e) {
      return { success: false, error: '条件表达式解析失败: ' + e.message };
    }
    updates.condition = data.condition;
  }
  if (data.actions !== undefined) {
    if (!Array.isArray(data.actions) || data.actions.length === 0) {
      return { success: false, error: '保护动作列表不能为空' };
    }
    for (const a of data.actions) {
      if (!a.deviceId || typeof a.address !== 'number' || typeof a.value !== 'number') {
        return { success: false, error: '每个动作必须包含 deviceId, address, value' };
      }
    }
    updates.actions = JSON.stringify(data.actions);
  }
  if (data.priority !== undefined) {
    if (data.priority < 1 || data.priority > 5) {
      return { success: false, error: '优先级必须在1-5之间' };
    }
    updates.priority = data.priority;
  }
  if (data.enabled !== undefined) {
    updates.enabled = data.enabled ? 1 : 0;
    const prevState = interlockStore.getState(id);
    if (!data.enabled) {
      interlockStore.setState(id, 'disabled');
      interlockStore.setTriggeredInfo(id, null);
      interlockStore.clearWritesForInterlock(id);
    } else if (prevState === 'disabled') {
      interlockStore.setState(id, 'normal');
    }
  }
  if (data.autoReset !== undefined) {
    updates.auto_reset = data.autoReset ? 1 : 0;
  }

  if (Object.keys(updates).length === 0) {
    return { success: true, interlock: await getInterlockById(id) };
  }

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const params = Object.values(updates);
  params.push(id);

  await run(`UPDATE interlocks SET ${sets} WHERE id = ?`, params);
  return { success: true, interlock: await getInterlockById(id) };
}

async function deleteInterlock(id) {
  const row = await get('SELECT id FROM interlocks WHERE id = ?', [id]);
  if (!row) return false;
  await run('DELETE FROM interlocks WHERE id = ?', [id]);
  interlockStore.setTriggeredInfo(id, null);
  interlockStore.clearWritesForInterlock(id);
  return true;
}

async function resetInterlock(id) {
  const row = await get('SELECT * FROM interlocks WHERE id = ?', [id]);
  if (!row) return { success: false, error: '联锁规则不存在', code: 404 };

  const state = interlockStore.getState(id);
  if (state !== 'triggered') {
    return { success: true, message: '联锁未处于触发状态' };
  }

  let triggerValue;
  try {
    triggerValue = evaluateExpression(row.condition, resolveRegisterReference);
  } catch (e) {
    return { success: false, error: '条件表达式求值失败: ' + e.message, code: 500 };
  }

  if (toBool(triggerValue)) {
    return {
      success: false,
      error: '联锁条件未恢复，无法复位',
      currentTriggerValue: triggerValue,
      code: 400
    };
  }

  interlockStore.setState(id, 'normal');
  interlockStore.setTriggeredInfo(id, null);
  interlockStore.clearWritesForInterlock(id);

  return { success: true };
}

async function getEvents(limit = 100) {
  const n = Math.min(Math.max(parseInt(limit) || 100, 1), 1000);
  const rows = await all(
    'SELECT * FROM interlock_events ORDER BY timestamp DESC LIMIT ?',
    [n]
  );
  return rows.map(r => ({
    id: r.id,
    interlockId: r.interlock_id,
    interlockName: r.interlock_name,
    triggerValue: r.trigger_value,
    actions: JSON.parse(r.actions),
    timestamp: r.timestamp
  }));
}

async function logEvent(interlockId, interlockName, triggerValue, actions) {
  const now = Date.now();
  await run(
    'INSERT INTO interlock_events (interlock_id, interlock_name, trigger_value, actions, timestamp) VALUES (?, ?, ?, ?, ?)',
    [interlockId, interlockName, triggerValue, JSON.stringify(actions), now]
  );
}

function executeActions(interlockId, interlockName, priority, actions) {
  const now = Date.now();
  for (const action of actions) {
    if (maintenanceService.isDeviceLocked(action.deviceId)) {
      maintenanceService.logSuppressedInterlock(
        action.deviceId, interlockId, interlockName
      ).catch(e => console.error('记录维保抑制事件失败:', e));
      continue;
    }
    if (interlockStore.recordWrite(interlockId, priority, action.deviceId, action.address, action.value, now)) {
      deviceStore.setRegisterValue(action.deviceId, action.address, 'float32', action.value);
    }
  }
}

async function scanOnce() {
  const rows = await all('SELECT * FROM interlocks WHERE enabled = 1');
  for (const row of rows) {
    const currentState = interlockStore.getState(row.id);

    let triggerValue;
    try {
      triggerValue = evaluateExpression(row.condition, resolveRegisterReference);
    } catch (e) {
      continue;
    }

    const triggered = toBool(triggerValue);
    const actions = JSON.parse(row.actions);

    if (triggered && currentState !== 'triggered') {
      interlockStore.setState(row.id, 'triggered');
      interlockStore.setTriggeredInfo(row.id, {
        triggerValue,
        triggeredAt: Date.now()
      });
      executeActions(row.id, row.name, row.priority, actions);
      await logEvent(row.id, row.name, triggerValue, actions);
    } else if (triggered && currentState === 'triggered') {
      executeActions(row.id, row.name, row.priority, actions);
    } else if (!triggered && currentState === 'triggered') {
      if (row.auto_reset) {
        interlockStore.setState(row.id, 'normal');
        interlockStore.setTriggeredInfo(row.id, null);
        interlockStore.clearWritesForInterlock(row.id);
      }
    }
  }
}

let scanTimer = null;

function startEngine() {
  if (scanTimer) return;
  scanTimer = setInterval(() => {
    scanOnce().catch(e => console.error('联锁扫描错误:', e));
  }, SCAN_INTERVAL_MS);
  console.log(`联锁引擎已启动 (扫描间隔 ${SCAN_INTERVAL_MS}ms)`);
}

function stopEngine() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

module.exports = {
  createInterlock,
  getInterlockById,
  getAllInterlocks,
  updateInterlock,
  deleteInterlock,
  resetInterlock,
  getEvents,
  startEngine,
  stopEngine,
  scanOnce,
  resolveRegisterReference
};
