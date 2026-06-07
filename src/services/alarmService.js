const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const alarmStateStore = require('../store/alarmStateStore');
const notificationService = require('./notificationService');

const VALID_NOTIFY_CHANNELS = ['log', 'webhook', 'both'];

function validateRule(body) {
  if (!body.deviceId) return '缺少deviceId';
  if (body.regAddress === undefined) return '缺少regAddress';
  if (!['high_high', 'high', 'low', 'low_low'].includes(body.alarmType)) {
    return '报警类型必须是high_high/high/low/low_low之一';
  }
  if (typeof body.threshold !== 'number') return '阈值必须是数字';
  if (typeof body.hysteresis !== 'undefined' && typeof body.hysteresis !== 'number') {
    return '死区必须是数字';
  }
  if (typeof body.delaySeconds !== 'undefined' && (typeof body.delaySeconds !== 'number' || body.delaySeconds < 0)) {
    return '延迟确认时间必须是非负数字';
  }
  if (!deviceStore.hasDevice(body.deviceId)) return '设备不存在';

  if (body.notifyChannel !== undefined) {
    if (!VALID_NOTIFY_CHANNELS.includes(body.notifyChannel)) {
      return 'notifyChannel必须是log/webhook/both之一';
    }
    if (body.notifyChannel !== 'log' && !body.webhookUrl) {
      return 'notifyChannel包含webhook时必须提供webhookUrl';
    }
  }
  if (body.escalateAfterSeconds !== undefined && (typeof body.escalateAfterSeconds !== 'number' || body.escalateAfterSeconds < 0)) {
    return 'escalateAfterSeconds必须是非负数字';
  }
  return null;
}

function isTriggerCondition(value, alarmType, threshold) {
  switch (alarmType) {
    case 'high_high':
    case 'high':
      return value > threshold;
    case 'low':
    case 'low_low':
      return value < threshold;
    default:
      return false;
  }
}

function isRecoveryCondition(value, alarmType, threshold, hysteresis) {
  const h = hysteresis || 0;
  switch (alarmType) {
    case 'high_high':
    case 'high':
      return value < (threshold - h);
    case 'low':
    case 'low_low':
      return value > (threshold + h);
    default:
      return false;
  }
}

async function createRule(body) {
  const err = validateRule(body);
  if (err) return { success: false, error: err };

  const id = uuidv4();
  const hysteresis = body.hysteresis || 0;
  const delaySeconds = body.delaySeconds || 0;
  const notifyChannel = body.notifyChannel || 'log';
  const escalateAfterSeconds = body.escalateAfterSeconds !== undefined ? body.escalateAfterSeconds : 0;
  const webhookUrl = body.webhookUrl || null;

  await run(
    `INSERT INTO alarm_rules (id, device_id, reg_address, alarm_type, threshold, hysteresis, delay_seconds, notify_channel, escalate_after_seconds, webhook_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, body.deviceId, body.regAddress, body.alarmType, body.threshold, hysteresis, delaySeconds, notifyChannel, escalateAfterSeconds, webhookUrl]
  );

  return { success: true, rule: await getRuleById(id) };
}

async function updateRule(id, body) {
  const existing = await get('SELECT * FROM alarm_rules WHERE id = ?', [id]);
  if (!existing) return { success: false, error: '报警规则不存在' };

  const mergedBody = {
    deviceId: existing.device_id,
    regAddress: existing.reg_address,
    alarmType: existing.alarm_type,
    threshold: existing.threshold,
    hysteresis: existing.hysteresis,
    delaySeconds: existing.delay_seconds,
    notifyChannel: existing.notify_channel,
    escalateAfterSeconds: existing.escalate_after_seconds,
    webhookUrl: existing.webhook_url,
    ...body
  };

  const err = validateRule(mergedBody);
  if (err) return { success: false, error: err };

  const updates = {};
  if (body.deviceId !== undefined) updates.device_id = body.deviceId;
  if (body.regAddress !== undefined) updates.reg_address = body.regAddress;
  if (body.alarmType !== undefined) updates.alarm_type = body.alarmType;
  if (body.threshold !== undefined) updates.threshold = body.threshold;
  if (body.hysteresis !== undefined) updates.hysteresis = body.hysteresis;
  if (body.delaySeconds !== undefined) updates.delay_seconds = body.delaySeconds;
  if (body.notifyChannel !== undefined) updates.notify_channel = body.notifyChannel;
  if (body.escalateAfterSeconds !== undefined) updates.escalate_after_seconds = body.escalateAfterSeconds;
  if (body.webhookUrl !== undefined) updates.webhook_url = body.webhookUrl;

  if (Object.keys(updates).length === 0) {
    return { success: true, rule: await getRuleById(id) };
  }

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const params = Object.values(updates);
  params.push(id);

  await run(`UPDATE alarm_rules SET ${sets} WHERE id = ?`, params);
  return { success: true, rule: await getRuleById(id) };
}

function formatRule(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    regAddress: row.reg_address,
    alarmType: row.alarm_type,
    threshold: row.threshold,
    hysteresis: row.hysteresis,
    delaySeconds: row.delay_seconds,
    notifyChannel: row.notify_channel || 'log',
    escalateAfterSeconds: row.escalate_after_seconds !== undefined ? row.escalate_after_seconds : 0,
    webhookUrl: row.webhook_url || null
  };
}

async function getRuleById(id) {
  const row = await get('SELECT * FROM alarm_rules WHERE id = ?', [id]);
  if (!row) return null;
  return formatRule(row);
}

async function getAllRules() {
  const rows = await all('SELECT * FROM alarm_rules');
  return rows.map(formatRule);
}

async function getRulesByDevice(deviceId) {
  const rows = await all('SELECT * FROM alarm_rules WHERE device_id = ?', [deviceId]);
  return rows.map(formatRule);
}

async function evaluateRule(rule, now) {
  const reg = await get('SELECT * FROM registers WHERE device_id = ? AND address = ?',
    [rule.deviceId, rule.regAddress]);
  if (!reg) return;

  const { value } = deviceStore.getRegisterValue(rule.deviceId, rule.regAddress, reg.data_type);
  const pending = alarmStateStore.getPending(rule.id);

  const activeAlarm = await get(`SELECT * FROM alarms WHERE rule_id = ? AND active = 1`, [rule.id]);

  if (activeAlarm) {
    if (isRecoveryCondition(value, rule.alarmType, rule.threshold, rule.hysteresis)) {
      await run(`UPDATE alarms SET active = 0, recovered_at = ? WHERE id = ?`, [now, activeAlarm.id]);
      alarmStateStore.clearPending(rule.id);
    } else {
      await run(`UPDATE alarms SET current_value = ? WHERE id = ?`, [value, activeAlarm.id]);
    }
    return;
  }

  if (isTriggerCondition(value, rule.alarmType, rule.threshold)) {
    if (rule.delaySeconds > 0) {
      if (!pending) {
        alarmStateStore.setPending(rule.id, { triggeredAt: now, value });
      } else {
        const elapsed = (now - pending.triggeredAt) / 1000;
        if (elapsed >= rule.delaySeconds) {
          await triggerAlarm(rule, value, now);
          alarmStateStore.clearPending(rule.id);
        }
      }
    } else {
      await triggerAlarm(rule, value, now);
    }
  } else {
    if (pending) {
      alarmStateStore.clearPending(rule.id);
    }
  }
}

async function triggerAlarm(rule, value, now) {
  const insertResult = await run(
    `INSERT INTO alarms (rule_id, device_id, reg_address, alarm_type, threshold, current_value, triggered_at, recovered_at, acknowledged, acknowledged_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, 1)`,
    [rule.id, rule.deviceId, rule.regAddress, rule.alarmType, rule.threshold, value, now]
  );

  const alarmId = insertResult.lastID;

  const deviceRow = await get('SELECT name FROM devices WHERE id = ?', [rule.deviceId]);
  const regRow = await get('SELECT name FROM registers WHERE device_id = ? AND address = ?', [rule.deviceId, rule.regAddress]);
  const deviceName = deviceRow ? deviceRow.name : rule.deviceId;
  const regName = regRow ? regRow.name : `reg${rule.regAddress}`;

  await notificationService.createNotification(
    {
      id: alarmId,
      current_value: value,
      threshold: rule.threshold,
      alarm_type: rule.alarmType
    },
    deviceName,
    regName,
    rule.notifyChannel || 'log'
  );
}

async function evaluateAlarmsForDevice(deviceId) {
  const rules = await getRulesByDevice(deviceId);
  const now = Date.now();
  for (const rule of rules) {
    await evaluateRule(rule, now);
  }
}

async function evaluateAllAlarms() {
  const rules = await getAllRules();
  const now = Date.now();
  for (const rule of rules) {
    await evaluateRule(rule, now);
  }
}

async function getActiveAlarms() {
  const rows = await all(`
    SELECT a.*, d.name as device_name, r.name as reg_name
    FROM alarms a
    JOIN devices d ON a.device_id = d.id
    LEFT JOIN registers r ON a.device_id = r.device_id AND a.reg_address = r.address
    WHERE a.active = 1
    ORDER BY a.triggered_at DESC
  `);

  const now = Date.now();
  return rows.map(row => ({
    id: row.id,
    ruleId: row.rule_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    regAddress: row.reg_address,
    regName: row.reg_name,
    alarmType: row.alarm_type,
    threshold: row.threshold,
    currentValue: row.current_value,
    triggeredAt: row.triggered_at,
    durationMs: now - row.triggered_at,
    acknowledged: !!row.acknowledged,
    acknowledgedAt: row.acknowledged_at
  }));
}

async function getAlarmHistory(deviceId, startTime, endTime) {
  let sql = `
    SELECT a.*, d.name as device_name, r.name as reg_name
    FROM alarms a
    JOIN devices d ON a.device_id = d.id
    LEFT JOIN registers r ON a.device_id = r.device_id AND a.reg_address = r.address
    WHERE 1=1
  `;
  const params = [];

  if (deviceId) {
    sql += ' AND a.device_id = ?';
    params.push(deviceId);
  }
  if (startTime) {
    sql += ' AND a.triggered_at >= ?';
    params.push(startTime);
  }
  if (endTime) {
    sql += ' AND a.triggered_at <= ?';
    params.push(endTime);
  }
  sql += ' ORDER BY a.triggered_at DESC';

  const rows = await all(sql, params);
  return rows.map(row => ({
    id: row.id,
    ruleId: row.rule_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    regAddress: row.reg_address,
    regName: row.reg_name,
    alarmType: row.alarm_type,
    threshold: row.threshold,
    currentValue: row.current_value,
    triggeredAt: row.triggered_at,
    recoveredAt: row.recovered_at,
    active: !!row.active,
    acknowledged: !!row.acknowledged,
    acknowledgedAt: row.acknowledged_at
  }));
}

async function acknowledgeAlarm(id) {
  const alarm = await get('SELECT * FROM alarms WHERE id = ?', [id]);
  if (!alarm) return { success: false, error: '报警不存在' };
  if (alarm.acknowledged) return { success: true, alreadyAcknowledged: true };

  await run('UPDATE alarms SET acknowledged = 1, acknowledged_at = ? WHERE id = ?',
    [Date.now(), id]);

  await notificationService.resolveNotificationsForAlarm(id);

  return { success: true };
}

module.exports = {
  createRule,
  updateRule,
  getRuleById,
  getAllRules,
  getActiveAlarms,
  getAlarmHistory,
  acknowledgeAlarm,
  evaluateAlarmsForDevice,
  evaluateAllAlarms
};
