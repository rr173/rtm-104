const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const inspectionStore = require('../store/inspectionStore');
const maintenanceService = require('./maintenanceService');

const VALID_PERIODS = ['daily', 'weekly', 'monthly'];
const VALID_CHECK_TYPES = ['visual', 'measurement', 'confirm'];
const SCAN_INTERVAL_MS = 60000;

function formatTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    deviceType: row.device_type,
    period: row.period,
    createdAt: row.created_at
  };
}

function formatTemplateItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    templateId: row.template_id,
    itemName: row.item_name,
    checkType: row.check_type,
    lowerLimit: row.lower_limit !== null && row.lower_limit !== undefined ? row.lower_limit : null,
    upperLimit: row.upper_limit !== null && row.upper_limit !== undefined ? row.upper_limit : null,
    isCritical: !!row.is_critical,
    autoReadAddress: row.auto_read_address != null ? row.auto_read_address : null,
    sortOrder: row.sort_order
  };
}

function formatTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    templateId: row.template_id,
    deviceId: row.device_id,
    status: row.status,
    deadline: row.deadline,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    passRate: row.pass_rate,
    qualified: !!row.qualified,
    autoMaintenanceOrderId: row.auto_maintenance_order_id || null,
    createdAt: row.created_at
  };
}

function formatResultItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    itemName: row.item_name,
    checkType: row.check_type,
    valueText: row.value_text,
    valueNumeric: row.value_numeric,
    pass: !!row.pass,
    isCritical: !!row.is_critical,
    autoRead: !!row.auto_read,
    autoReadAddress: row.auto_read_address,
    lowerLimit: row.lower_limit,
    upperLimit: row.upper_limit,
    sortOrder: row.sort_order
  };
}

async function createTemplate(body) {
  if (!body.name || typeof body.name !== 'string') {
    return { success: false, error: '模板名称不能为空', code: 400 };
  }
  if (!body.deviceType || typeof body.deviceType !== 'string') {
    return { success: false, error: '适用设备类型不能为空', code: 400 };
  }
  if (!VALID_PERIODS.includes(body.period)) {
    return { success: false, error: '巡检周期必须是daily/weekly/monthly', code: 400 };
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { success: false, error: '检查项列表不能为空', code: 400 };
  }

  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    if (!item.itemName || typeof item.itemName !== 'string') {
      return { success: false, error: `第${i + 1}项名称不能为空`, code: 400 };
    }
    if (!VALID_CHECK_TYPES.includes(item.checkType)) {
      return { success: false, error: `第${i + 1}项检查类型必须是visual/measurement/confirm`, code: 400 };
    }
    if (item.checkType === 'measurement') {
      if (typeof item.lowerLimit !== 'number' || typeof item.upperLimit !== 'number') {
        return { success: false, error: `第${i + 1}项measurement类型需配置上下限`, code: 400 };
      }
      if (item.lowerLimit >= item.upperLimit) {
        return { success: false, error: `第${i + 1}项下限必须小于上限`, code: 400 };
      }
    }
  }

  const id = uuidv4();
  const now = Date.now();

  await run(
    `INSERT INTO inspection_templates (id, name, device_type, period, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, body.name, body.deviceType, body.period, now]
  );

  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    await run(
      `INSERT INTO inspection_template_items (template_id, item_name, check_type, lower_limit, upper_limit, is_critical, auto_read_address, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        item.itemName,
        item.checkType,
        item.checkType === 'measurement' ? item.lowerLimit : null,
        item.checkType === 'measurement' ? item.upperLimit : null,
        item.isCritical ? 1 : 0,
        item.checkType === 'measurement' && item.autoReadAddress != null ? item.autoReadAddress : null,
        i
      ]
    );
  }

  return { success: true, template: await getTemplateById(id) };
}

async function getTemplateById(id) {
  const row = await get('SELECT * FROM inspection_templates WHERE id = ?', [id]);
  if (!row) return null;
  const tmpl = formatTemplate(row);
  const items = await all('SELECT * FROM inspection_template_items WHERE template_id = ? ORDER BY sort_order', [id]);
  tmpl.items = items.map(formatTemplateItem);
  return tmpl;
}

async function listTemplates(query = {}) {
  let sql = 'SELECT * FROM inspection_templates WHERE 1=1';
  const params = [];
  if (query.period) {
    sql += ' AND period = ?';
    params.push(query.period);
  }
  if (query.deviceType) {
    sql += ' AND device_type = ?';
    params.push(query.deviceType);
  }
  sql += ' ORDER BY created_at DESC';
  const rows = await all(sql, params);
  const result = [];
  for (const row of rows) {
    const tmpl = formatTemplate(row);
    const items = await all('SELECT * FROM inspection_template_items WHERE template_id = ? ORDER BY sort_order', [tmpl.id]);
    tmpl.items = items.map(formatTemplateItem);
    result.push(tmpl);
  }
  return result;
}

async function deleteTemplate(id) {
  const tmpl = await get('SELECT * FROM inspection_templates WHERE id = ?', [id]);
  if (!tmpl) return { success: false, error: '模板不存在', code: 404 };
  await run('DELETE FROM inspection_template_items WHERE template_id = ?', [id]);
  await run('DELETE FROM inspection_templates WHERE id = ?', [id]);
  return { success: true };
}

function computeDeadline(period) {
  const now = new Date();
  if (period === 'daily') {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return end.getTime();
  } else if (period === 'weekly') {
    const day = now.getDay();
    const daysToSunday = day === 0 ? 0 : 7 - day;
    const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToSunday, 23, 59, 59, 999);
    return sunday.getTime();
  } else if (period === 'monthly') {
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), lastDay.getDate(), 23, 59, 59, 999);
    return end.getTime();
  }
  return now.getTime();
}

async function generateTasksForTemplate(template) {
  const deviceRows = await all('SELECT id FROM devices');
  const devices = deviceRows.filter(d => deviceStore.hasDevice(d.id));

  const now = Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);
  const deadline = computeDeadline(template.period);

  let generated = 0;
  for (const dev of devices) {
    const existing = await get(
      `SELECT id FROM inspection_tasks WHERE template_id = ? AND device_id = ? AND created_at >= ? AND created_at < ?`,
      [template.id, dev.id, new Date(todayStr).getTime(), new Date(todayStr).getTime() + 86400000]
    );
    if (existing) continue;

    const taskId = uuidv4();
    await run(
      `INSERT INTO inspection_tasks (id, template_id, device_id, status, deadline, created_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
      [taskId, template.id, dev.id, deadline, now]
    );
    generated++;
  }
  return generated;
}

async function generateTasks() {
  const templates = await all('SELECT * FROM inspection_templates');
  let totalGenerated = 0;

  for (const tmpl of templates) {
    if (tmpl.period === 'daily') {
      totalGenerated += await generateTasksForTemplate(tmpl);
    } else if (tmpl.period === 'weekly') {
      const now = new Date();
      if (now.getDay() === 1) {
        totalGenerated += await generateTasksForTemplate(tmpl);
      }
    } else if (tmpl.period === 'monthly') {
      const now = new Date();
      if (now.getDate() === 1) {
        totalGenerated += await generateTasksForTemplate(tmpl);
      }
    }
  }

  if (totalGenerated > 0) {
    console.log(`[巡检] 自动生成 ${totalGenerated} 个巡检任务`);
  }
}

async function markOverdueTasks() {
  const now = Date.now();
  const result = await run(
    `UPDATE inspection_tasks SET status = 'overdue' WHERE status IN ('pending', 'in_progress') AND deadline < ?`,
    [now]
  );
  if (result.changes > 0) {
    console.log(`[巡检] 标记 ${result.changes} 个超期巡检任务`);
  }
}

async function getTaskById(id) {
  const row = await get('SELECT * FROM inspection_tasks WHERE id = ?', [id]);
  return formatTask(row);
}

async function listTasks(query = {}) {
  let sql = 'SELECT * FROM inspection_tasks WHERE 1=1';
  const params = [];
  if (query.status) {
    sql += ' AND status = ?';
    params.push(query.status);
  }
  if (query.deviceId) {
    sql += ' AND device_id = ?';
    params.push(query.deviceId);
  }
  if (query.templateId) {
    sql += ' AND template_id = ?';
    params.push(query.templateId);
  }
  sql += ' ORDER BY created_at DESC';
  if (query.limit) {
    sql += ' LIMIT ?';
    params.push(Math.min(Math.max(parseInt(query.limit) || 100, 1), 1000));
  }
  const rows = await all(sql, params);
  return rows.map(formatTask);
}

async function startTask(id) {
  const task = await get('SELECT * FROM inspection_tasks WHERE id = ?', [id]);
  if (!task) return { success: false, error: '巡检任务不存在', code: 404 };
  if (task.status !== 'pending') {
    return { success: false, error: `只有pending状态的任务可以开始，当前状态: ${task.status}`, code: 400 };
  }

  const now = Date.now();
  await run(`UPDATE inspection_tasks SET status = 'in_progress', started_at = ? WHERE id = ?`, [now, id]);

  const tmplItems = await all('SELECT * FROM inspection_template_items WHERE template_id = ? ORDER BY sort_order', [task.template_id]);
  for (const item of tmplItems) {
    await run(
      `INSERT INTO inspection_result_items (task_id, item_name, check_type, is_critical, auto_read, auto_read_address, lower_limit, upper_limit, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        item.item_name,
        item.check_type,
        item.is_critical,
        item.auto_read_address != null ? 1 : 0,
        item.auto_read_address,
        item.lower_limit,
        item.upper_limit,
        item.sort_order
      ]
    );
  }

  console.log(`[巡检] 任务开始: taskId=${id}, deviceId=${task.device_id}`);
  return { success: true, task: await getTaskDetailById(id) };
}

async function readRegisterFromDevice(deviceId, address) {
  if (!deviceStore.hasDevice(deviceId)) return null;
  const reg = await get('SELECT * FROM registers WHERE device_id = ? AND address = ?', [deviceId, address]);
  if (!reg) return null;
  const { value } = deviceStore.getRegisterValue(deviceId, address, reg.data_type);
  return value;
}

async function fillResultItem(taskId, itemId, body) {
  const task = await get('SELECT * FROM inspection_tasks WHERE id = ?', [taskId]);
  if (!task) return { success: false, error: '巡检任务不存在', code: 404 };
  if (task.status !== 'in_progress') {
    return { success: false, error: '只有执行中的任务可以填写结果', code: 400 };
  }

  const resultItem = await get('SELECT * FROM inspection_result_items WHERE id = ? AND task_id = ?', [itemId, taskId]);
  if (!resultItem) return { success: false, error: '检查项不存在', code: 404 };

  let valueText = null;
  let valueNumeric = null;
  let pass = false;
  let autoRead = false;

  if (resultItem.check_type === 'visual' || resultItem.check_type === 'confirm') {
    if (!body.result || !['pass', 'fail'].includes(body.result)) {
      return { success: false, error: 'visual/confirm类型结果必须为pass或fail', code: 400 };
    }
    valueText = body.result;
    pass = body.result === 'pass';
  } else if (resultItem.check_type === 'measurement') {
    let measuredValue = body.value;

    if (body.autoRead && resultItem.auto_read_address != null) {
      const regValue = await readRegisterFromDevice(task.device_id, resultItem.auto_read_address);
      if (regValue !== null) {
        measuredValue = regValue;
        autoRead = true;
      }
    }

    if (typeof measuredValue !== 'number') {
      return { success: false, error: 'measurement类型需提供实测数值或自动读取', code: 400 };
    }

    valueNumeric = measuredValue;
    valueText = String(measuredValue);
    pass = measuredValue >= resultItem.lower_limit && measuredValue <= resultItem.upper_limit;
  }

  await run(
    `UPDATE inspection_result_items SET value_text = ?, value_numeric = ?, pass = ?, auto_read = ? WHERE id = ?`,
    [valueText, valueNumeric, pass ? 1 : 0, autoRead ? 1 : 0, itemId]
  );

  return { success: true, item: formatResultItem(await get('SELECT * FROM inspection_result_items WHERE id = ?', [itemId])) };
}

async function submitTask(id) {
  const task = await get('SELECT * FROM inspection_tasks WHERE id = ?', [id]);
  if (!task) return { success: false, error: '巡检任务不存在', code: 404 };
  if (task.status !== 'in_progress') {
    return { success: false, error: '只有执行中的任务可以提交', code: 400 };
  }

  const items = await all('SELECT * FROM inspection_result_items WHERE task_id = ? ORDER BY sort_order', [id]);

  const unfilled = items.filter(i => i.value_text === null && i.value_numeric === null);
  if (unfilled.length > 0) {
    return { success: false, error: `还有 ${unfilled.length} 个检查项未填写`, code: 400 };
  }

  const totalItems = items.length;
  const passItems = items.filter(i => i.pass).length;
  const passRate = totalItems > 0 ? passItems / totalItems : 1;

  const criticalFailed = items.filter(i => i.is_critical && !i.pass);
  const qualified = criticalFailed.length === 0 && passRate >= 0.8;

  const now = Date.now();
  await run(
    `UPDATE inspection_tasks SET status = 'completed', completed_at = ?, pass_rate = ?, qualified = ? WHERE id = ?`,
    [now, passRate, qualified ? 1 : 0, id]
  );

  console.log(`[巡检] 任务完成: taskId=${id}, 合格率=${(passRate * 100).toFixed(1)}%, 整体判定=${qualified ? '合格' : '不合格'}`);

  if (criticalFailed.length > 0) {
    const plannedStart = now + 3600000;
    const plannedEnd = now + 86400000;
    const failedNames = criticalFailed.map(i => i.item_name).join(', ');

    const orderResult = await maintenanceService.createOrder({
      deviceId: task.device_id,
      maintenanceType: 'planned',
      plannedStartAt: plannedStart,
      plannedEndAt: plannedEnd,
      description: `巡检不合格(关键项)自动生成: ${failedNames}`
    });

    if (orderResult.success) {
      console.log(`[巡检] 关键项不合格，自动创建维保工单: orderId=${orderResult.order.id}`);
      await run(
        `UPDATE inspection_tasks SET auto_maintenance_order_id = ? WHERE id = ?`,
        [orderResult.order.id, id]
      );
    } else {
      console.error(`[巡检] 自动创建维保工单失败: ${orderResult.error}`);
    }
  }

  return { success: true, task: await getTaskDetailById(id) };
}

async function getTaskDetailById(id) {
  const task = await getTaskById(id);
  if (!task) return null;
  const items = await all('SELECT * FROM inspection_result_items WHERE task_id = ? ORDER BY sort_order', [id]);
  task.resultItems = items.map(formatResultItem);

  const tmpl = await get('SELECT * FROM inspection_templates WHERE id = ?', [task.templateId]);
  if (tmpl) {
    task.templateName = tmpl.name;
    task.templatePeriod = tmpl.period;
  }
  return task;
}

async function getInspectionHistory(query = {}) {
  let sql = `SELECT t.*, tmpl.name as template_name, tmpl.period as template_period
             FROM inspection_tasks t
             LEFT JOIN inspection_templates tmpl ON t.template_id = tmpl.id
             WHERE t.status IN ('completed', 'overdue')`;
  const params = [];

  if (query.deviceId) {
    sql += ' AND t.device_id = ?';
    params.push(query.deviceId);
  }
  if (query.startDate) {
    sql += ' AND t.completed_at >= ?';
    params.push(parseInt(query.startDate));
  }
  if (query.endDate) {
    sql += ' AND t.completed_at <= ?';
    params.push(parseInt(query.endDate));
  }

  sql += ' ORDER BY t.completed_at DESC';

  if (query.limit) {
    sql += ' LIMIT ?';
    params.push(Math.min(Math.max(parseInt(query.limit) || 100, 1), 1000));
  }

  const rows = await all(sql, params);
  return rows.map(r => ({
    id: r.id,
    templateId: r.template_id,
    templateName: r.template_name,
    templatePeriod: r.template_period,
    deviceId: r.device_id,
    status: r.status,
    deadline: r.deadline,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    passRate: r.pass_rate,
    qualified: !!r.qualified,
    autoMaintenanceOrderId: r.auto_maintenance_order_id || null,
    createdAt: r.created_at
  }));
}

async function getDeviceInspectionRecords(deviceId) {
  const tasks = await all(
    `SELECT t.*, tmpl.name as template_name, tmpl.period as template_period
     FROM inspection_tasks t
     LEFT JOIN inspection_templates tmpl ON t.template_id = tmpl.id
     WHERE t.device_id = ?
     ORDER BY t.created_at DESC`,
    [deviceId]
  );

  const result = [];
  for (const task of tasks) {
    const items = await all('SELECT * FROM inspection_result_items WHERE task_id = ? ORDER BY sort_order', [task.id]);
    result.push({
      id: task.id,
      templateName: task.template_name,
      templatePeriod: task.template_period,
      status: task.status,
      deadline: task.deadline,
      startedAt: task.started_at,
      completedAt: task.completed_at,
      passRate: task.pass_rate,
      qualified: !!task.qualified,
      createdAt: task.created_at,
      resultItems: items.map(formatResultItem)
    });
  }
  return result;
}

async function getDevicePassRateTrend(deviceId) {
  const tasks = await all(
    `SELECT t.*, tmpl.name as template_name, tmpl.period as template_period
     FROM inspection_tasks t
     LEFT JOIN inspection_templates tmpl ON t.template_id = tmpl.id
     WHERE t.device_id = ? AND t.status = 'completed'
     ORDER BY t.completed_at ASC`,
    [deviceId]
  );

  const byPeriod = {};
  for (const task of tasks) {
    const period = task.template_period || 'unknown';
    if (!byPeriod[period]) {
      byPeriod[period] = [];
    }
    byPeriod[period].push({
      taskId: task.id,
      templateName: task.template_name,
      completedAt: task.completed_at,
      passRate: task.pass_rate,
      qualified: !!task.qualified
    });
  }

  const summary = {
    deviceId,
    totalCompleted: tasks.length,
    totalQualified: tasks.filter(t => t.qualified).length,
    overallPassRate: tasks.length > 0
      ? tasks.reduce((sum, t) => sum + (t.pass_rate || 0), 0) / tasks.length
      : null,
    trends: byPeriod
  };

  return summary;
}

async function seedData() {
  const count = await get('SELECT COUNT(*) as cnt FROM inspection_templates');
  if (count.cnt > 0) return;

  const now = Date.now();

  const dailyTemplateId = uuidv4();
  await run(
    `INSERT INTO inspection_templates (id, name, device_type, period, created_at) VALUES (?, ?, ?, ?, ?)`,
    [dailyTemplateId, '温控器日巡', '温控器', 'daily', now]
  );
  const dailyItems = [
    { itemName: '外观检查', checkType: 'visual', isCritical: false },
    { itemName: '当前温度', checkType: 'measurement', lowerLimit: 0, upperLimit: 100, isCritical: true, autoReadAddress: 0 },
    { itemName: '运行指示灯', checkType: 'confirm', isCritical: false },
    { itemName: '报警状态', checkType: 'confirm', isCritical: true }
  ];
  for (let i = 0; i < dailyItems.length; i++) {
    const item = dailyItems[i];
    await run(
      `INSERT INTO inspection_template_items (template_id, item_name, check_type, lower_limit, upper_limit, is_critical, auto_read_address, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [dailyTemplateId, item.itemName, item.checkType, item.lowerLimit != null ? item.lowerLimit : null, item.upperLimit != null ? item.upperLimit : null, item.isCritical ? 1 : 0, item.autoReadAddress != null ? item.autoReadAddress : null, i]
    );
  }

  const weeklyTemplateId = uuidv4();
  await run(
    `INSERT INTO inspection_templates (id, name, device_type, period, created_at) VALUES (?, ?, ?, ?, ?)`,
    [weeklyTemplateId, '变频器周巡', '变频器', 'weekly', now]
  );
  const weeklyItems = [
    { itemName: '散热风扇检查', checkType: 'visual', isCritical: false },
    { itemName: '输出频率', checkType: 'measurement', lowerLimit: 0, upperLimit: 60, isCritical: true, autoReadAddress: 1 },
    { itemName: '接线端子紧固', checkType: 'confirm', isCritical: false }
  ];
  for (let i = 0; i < weeklyItems.length; i++) {
    const item = weeklyItems[i];
    await run(
      `INSERT INTO inspection_template_items (template_id, item_name, check_type, lower_limit, upper_limit, is_critical, auto_read_address, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [weeklyTemplateId, item.itemName, item.checkType, item.lowerLimit != null ? item.lowerLimit : null, item.upperLimit != null ? item.upperLimit : null, item.isCritical ? 1 : 0, item.autoReadAddress != null ? item.autoReadAddress : null, i]
    );
  }

  const deviceRows = await all('SELECT id FROM devices LIMIT 1');
  if (deviceRows.length === 0) return;

  const deviceId = deviceRows[0].id;
  const completedAt = now - 86400000;
  const startedAt = completedAt - 1800000;
  const deadline = completedAt;
  const createdAt = startedAt - 60000;

  const histTaskId = uuidv4();
  await run(
    `INSERT INTO inspection_tasks (id, template_id, device_id, status, deadline, started_at, completed_at, pass_rate, qualified, created_at)
     VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`,
    [histTaskId, dailyTemplateId, deviceId, deadline, startedAt, completedAt, 0.75, 0, createdAt]
  );

  const histResults = [
    { itemName: '外观检查', checkType: 'visual', valueText: 'pass', valueNumeric: null, pass: true, isCritical: false },
    { itemName: '当前温度', checkType: 'measurement', valueText: '105', valueNumeric: 105, pass: false, isCritical: true, autoRead: true, autoReadAddress: 0, lowerLimit: 0, upperLimit: 100 },
    { itemName: '运行指示灯', checkType: 'confirm', valueText: 'pass', valueNumeric: null, pass: true, isCritical: false },
    { itemName: '报警状态', checkType: 'confirm', valueText: 'fail', valueNumeric: null, pass: false, isCritical: true }
  ];
  for (let i = 0; i < histResults.length; i++) {
    const r = histResults[i];
    await run(
      `INSERT INTO inspection_result_items (task_id, item_name, check_type, value_text, value_numeric, pass, is_critical, auto_read, auto_read_address, lower_limit, upper_limit, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [histTaskId, r.itemName, r.checkType, r.valueText, r.valueNumeric, r.pass ? 1 : 0, r.isCritical ? 1 : 0, r.autoRead ? 1 : 0, r.autoReadAddress || null, r.lowerLimit || null, r.upperLimit || null, i]
    );
  }

  const plannedStart = completedAt + 3600000;
  const plannedEnd = completedAt + 86400000;
  const orderResult = await maintenanceService.createOrder({
    deviceId,
    maintenanceType: 'planned',
    plannedStartAt: plannedStart,
    plannedEndAt: plannedEnd,
    description: '巡检不合格(关键项: 当前温度, 报警状态)自动生成'
  });

  if (orderResult.success) {
    await run(
      `UPDATE inspection_tasks SET auto_maintenance_order_id = ? WHERE id = ?`,
      [orderResult.order.id, histTaskId]
    );
  }

  console.log(`[巡检] 预置数据: 温控器日巡模板(4项)、变频器周巡模板(3项)`);
  console.log(`[巡检] 预置历史: 已完成巡检记录(含不合格项, 自动生成维保工单)`);
}

async function loadFromDB() {
  const count = await get('SELECT COUNT(*) as cnt FROM inspection_templates');
  return count.cnt;
}

let generationTimer = null;
let overdueTimer = null;

function startEngine() {
  if (generationTimer) return;

  generateTasks().catch(e => console.error('[巡检] 初始任务生成失败:', e));
  markOverdueTasks().catch(e => console.error('[巡检] 初始超期标记失败:', e));

  generationTimer = setInterval(() => {
    generateTasks().catch(e => console.error('[巡检] 任务生成错误:', e));
  }, SCAN_INTERVAL_MS);
  inspectionStore.setGenerationTimer(generationTimer);

  overdueTimer = setInterval(() => {
    markOverdueTasks().catch(e => console.error('[巡检] 超期标记错误:', e));
  }, SCAN_INTERVAL_MS);
  inspectionStore.setOverdueTimer(overdueTimer);

  console.log(`巡检任务引擎已启动 (扫描间隔 ${SCAN_INTERVAL_MS}ms)`);
}

function stopEngine() {
  if (generationTimer) {
    clearInterval(generationTimer);
    generationTimer = null;
  }
  if (overdueTimer) {
    clearInterval(overdueTimer);
    overdueTimer = null;
  }
  inspectionStore.clearAllTimers();
}

module.exports = {
  createTemplate,
  getTemplateById,
  listTemplates,
  deleteTemplate,
  getTaskById,
  listTasks,
  startTask,
  fillResultItem,
  submitTask,
  getTaskDetailById,
  getInspectionHistory,
  getDeviceInspectionRecords,
  getDevicePassRateTrend,
  seedData,
  loadFromDB,
  startEngine,
  stopEngine,
  generateTasks,
  markOverdueTasks
};
