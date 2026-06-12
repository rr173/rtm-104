const http = require('http');
const https = require('https');
const { URL } = require('url');
const { run, get, all } = require('../db/database');
const maintenanceService = require('./maintenanceService');

const SCAN_INTERVAL_MS = 5000;
const WEBHOOK_TIMEOUT_MS = 3000;
const WEBHOOK_RETRY_INTERVAL_MS = 2000;
const MAX_RETRIES = 3;
const VALID_STATUSES = ['pending', 'sent', 'escalated', 'resolved', 'failed'];

function sendWebhook(url, payload) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      reject(new Error('Invalid webhook URL'));
      return;
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const postData = JSON.stringify(payload);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: WEBHOOK_TIMEOUT_MS
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: data });
        } else {
          reject(new Error(`Webhook returned status ${res.statusCode}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.on('timeout', () => {
      req.destroy(new Error('Webhook request timed out'));
    });

    req.write(postData);
    req.end();
  });
}

async function createNotification(alarm, deviceName, regName, notifyChannel, isEscalation = false, parentNotificationId = null) {
  const now = Date.now();
  const result = await run(
    `INSERT INTO notifications (
      alarm_id, device_name, reg_name, current_value, threshold, alarm_type,
      notify_channel, status, retry_count, is_escalation, parent_notification_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    [
      alarm.id, deviceName, regName, alarm.current_value, alarm.threshold, alarm.alarm_type,
      notifyChannel, isEscalation ? 1 : 0, parentNotificationId, now
    ]
  );

  const notificationId = result.lastID;

  if (notifyChannel === 'log' || notifyChannel === 'both') {
    console.log(`[ALARM NOTIFICATION] alarmId=${alarm.id}, device=${deviceName}, register=${regName}, type=${alarm.alarm_type}, value=${alarm.current_value}, threshold=${alarm.threshold}, isEscalation=${isEscalation}`);
    await run('UPDATE notifications SET status = ?, sent_at = ? WHERE id = ? AND status = ? AND notify_channel != ?',
      ['sent', Date.now(), notificationId, 'pending', 'webhook']);
  }

  if (notifyChannel === 'webhook' || notifyChannel === 'both') {
    processWebhookNotification(notificationId).catch(e => console.error('处理webhook通知失败:', e));
  }

  return notificationId;
}

async function processWebhookNotification(notificationId) {
  const notif = await get('SELECT * FROM notifications WHERE id = ?', [notificationId]);
  if (!notif) return;
  if (notif.status === 'resolved') return;

  const alarm = await get('SELECT a.*, ar.webhook_url FROM alarms a JOIN alarm_rules ar ON a.rule_id = ar.id WHERE a.id = ?', [notif.alarm_id]);
  if (!alarm || !alarm.webhook_url) return;

  const payload = {
    notificationId: notif.id,
    alarmId: notif.alarm_id,
    deviceName: notif.device_name,
    regName: notif.reg_name,
    alarmType: notif.alarm_type,
    currentValue: notif.current_value,
    threshold: notif.threshold,
    triggeredAt: alarm.triggered_at,
    isEscalation: !!notif.is_escalation,
    timestamp: Date.now()
  };

  for (let attempt = notif.retry_count; attempt < MAX_RETRIES; attempt++) {
    try {
      await sendWebhook(alarm.webhook_url, payload);
      await run('UPDATE notifications SET status = ?, sent_at = ?, retry_count = ? WHERE id = ?',
        ['sent', Date.now(), attempt + 1, notificationId]);
      return;
    } catch (e) {
      await run('UPDATE notifications SET retry_count = ? WHERE id = ?', [attempt + 1, notificationId]);
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(resolve => setTimeout(resolve, WEBHOOK_RETRY_INTERVAL_MS));
        const current = await get('SELECT status FROM notifications WHERE id = ?', [notificationId]);
        if (!current || current.status === 'resolved') return;
      }
    }
  }

  await run('UPDATE notifications SET status = ? WHERE id = ?', ['failed', notificationId]);
}

async function processLogNotification(notificationId) {
  await run('UPDATE notifications SET status = ?, sent_at = ? WHERE id = ? AND status = ?',
    ['sent', Date.now(), notificationId, 'pending']);
}

async function resolveNotificationsForAlarm(alarmId) {
  const now = Date.now();
  await run('UPDATE notifications SET status = ?, resolved_at = ? WHERE alarm_id = ? AND status != ?',
    ['resolved', now, alarmId, 'resolved']);
}

async function getNotifications(status) {
  let sql = 'SELECT * FROM notifications';
  const params = [];
  if (status && VALID_STATUSES.includes(status)) {
    sql += ' WHERE status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC';
  const rows = await all(sql, params);
  return rows.map(formatNotification);
}

function formatNotification(row) {
  return {
    id: row.id,
    alarmId: row.alarm_id,
    deviceName: row.device_name,
    regName: row.reg_name,
    currentValue: row.current_value,
    threshold: row.threshold,
    alarmType: row.alarm_type,
    notifyChannel: row.notify_channel,
    status: row.status,
    retryCount: row.retry_count,
    isEscalation: !!row.is_escalation,
    parentNotificationId: row.parent_notification_id,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    resolvedAt: row.resolved_at
  };
}

async function getStats() {
  const totalRow = await get('SELECT COUNT(*) as count FROM notifications');
  const total = totalRow.count;

  const statusCounts = {};
  for (const s of VALID_STATUSES) {
    const row = await get('SELECT COUNT(*) as count FROM notifications WHERE status = ?', [s]);
    statusCounts[s] = row.count;
  }

  const escalatedRow = await get('SELECT COUNT(*) as count FROM notifications WHERE is_escalation = 1');
  const escalatedCount = escalatedRow.count;
  const escalateRate = total > 0 ? escalatedCount / total : 0;

  const ackDurations = await all(
    `SELECT (n.resolved_at - n.created_at) as duration 
     FROM notifications n 
     JOIN alarms a ON n.alarm_id = a.id 
     WHERE n.status = 'resolved' 
       AND a.acknowledged = 1 
       AND a.acknowledged_at IS NOT NULL 
       AND n.resolved_at IS NOT NULL`
  );

  let avgAckDurationMs = 0;
  if (ackDurations.length > 0) {
    const sum = ackDurations.reduce((acc, r) => acc + r.duration, 0);
    avgAckDurationMs = sum / ackDurations.length;
  }

  return {
    total,
    statusCounts,
    avgAckDurationMs,
    escalateRate
  };
}

async function scanForEscalations() {
  const now = Date.now();
  const unacknowledgedAlarms = await all(
    `SELECT a.*, d.name as device_name, r.name as reg_name, ar.escalate_after_seconds
     FROM alarms a
     JOIN alarm_rules ar ON a.rule_id = ar.id
     JOIN devices d ON a.device_id = d.id
     LEFT JOIN registers r ON a.device_id = r.device_id AND a.reg_address = r.address
     WHERE a.active = 1
       AND a.acknowledged = 0
       AND ar.escalate_after_seconds > 0`
  );

  for (const alarm of unacknowledgedAlarms) {
    if (maintenanceService.isDeviceLocked(alarm.device_id)) {
      continue;
    }

    const elapsedMs = now - alarm.triggered_at;
    const elapsedSeconds = elapsedMs / 1000;

    if (elapsedSeconds >= alarm.escalate_after_seconds) {
      const alreadyEscalated = await get(
        'SELECT COUNT(*) as count FROM notifications WHERE alarm_id = ? AND is_escalation = 1',
        [alarm.id]
      );

      if (alreadyEscalated.count === 0) {
        const originalNotif = await get(
          'SELECT * FROM notifications WHERE alarm_id = ? AND is_escalation = 0 ORDER BY created_at ASC LIMIT 1',
          [alarm.id]
        );

        if (originalNotif) {
          await run('UPDATE notifications SET status = ? WHERE id = ?', ['escalated', originalNotif.id]);
        }

        const deviceName = alarm.device_name;
        const regName = alarm.reg_name || `reg${alarm.reg_address}`;

        await createNotification(
          {
            id: alarm.id,
            current_value: alarm.current_value,
            threshold: alarm.threshold,
            alarm_type: alarm.alarm_type
          },
          deviceName,
          regName,
          'both',
          true,
          originalNotif ? originalNotif.id : null
        );
      }
    }
  }
}

let scanTimer = null;

function startEngine() {
  if (scanTimer) return;
  scanTimer = setInterval(() => {
    scanForEscalations().catch(e => console.error('通知升级扫描错误:', e));
  }, SCAN_INTERVAL_MS);
  console.log(`通知引擎已启动 (扫描间隔 ${SCAN_INTERVAL_MS}ms)`);
}

function stopEngine() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

module.exports = {
  createNotification,
  processWebhookNotification,
  processLogNotification,
  resolveNotificationsForAlarm,
  getNotifications,
  getStats,
  startEngine,
  stopEngine,
  scanForEscalations,
  VALID_STATUSES
};
