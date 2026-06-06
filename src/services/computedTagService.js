const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const computedTagStore = require('../store/computedTagStore');
const { parseExpression, evaluateExpression, getReferences } = require('../utils/expression');

function validateTag(body) {
  if (!body.name || typeof body.name !== 'string') return '缺少name';
  if (!body.expression || typeof body.expression !== 'string') return '缺少expression';
  if (!Array.isArray(body.sourceRegisters)) return '缺少sourceRegisters数组';
  if (typeof body.intervalMs !== 'number' || body.intervalMs < 100 || body.intervalMs > 60000) {
    return '计算周期必须在100-60000ms之间';
  }

  try {
    const ast = parseExpression(body.expression);
    const refs = getReferences(ast);
    for (const ref of refs) {
      const parts = ref.split('.');
      if (parts.length !== 2) return `引用格式错误: ${ref}，应为 deviceId.regAddress`;
      const [deviceId, regStr] = parts;
      const regAddress = parseInt(regStr.replace(/^reg/, ''));
      if (isNaN(regAddress)) return `引用格式错误: ${ref}`;
      if (!deviceStore.hasDevice(deviceId)) return `设备不存在: ${deviceId}`;
    }
  } catch (e) {
    return `表达式解析错误: ${e.message}`;
  }

  return null;
}

async function resolveReference(ref) {
  const parts = ref.split('.');
  const deviceId = parts[0];
  const regAddress = parseInt(parts[1].replace(/^reg/, ''));

  const reg = await get('SELECT * FROM registers WHERE device_id = ? AND address = ?',
    [deviceId, regAddress]);
  if (!reg) return 0;

  const { value } = deviceStore.getRegisterValue(deviceId, regAddress, reg.data_type);
  return value;
}

async function doComputeTag(tagId) {
  const tag = computedTagStore.tags.get(tagId);
  if (!tag) return;

  try {
    const refs = getReferences(parseExpression(tag.expression));
    const values = {};
    for (const ref of refs) {
      values[ref] = await resolveReference(ref);
    }
    const value = evaluateExpression(tag.expression, (ref) => values[ref] || 0);

    computedTagStore.updateValue(tagId, value);

    await run(`INSERT INTO computed_tag_history (tag_id, value, timestamp)
      VALUES (?, ?, ?)`, [tagId, value, Date.now()]);

    await run(`UPDATE computed_tags SET current_value = ? WHERE id = ?`, [value, tagId]);
  } catch (e) {
    console.error('Compute tag error:', tagId, e.message);
  }
}

async function createTag(body) {
  const err = validateTag(body);
  if (err) return { success: false, error: err };

  const id = uuidv4();

  await run(`INSERT INTO computed_tags (id, name, expression, source_registers, interval_ms, current_value)
    VALUES (?, ?, ?, ?, ?, NULL)`,
    [id, body.name, body.expression, JSON.stringify(body.sourceRegisters), body.intervalMs]);

  computedTagStore.addTag({
    id,
    name: body.name,
    expression: body.expression,
    sourceRegisters: body.sourceRegisters,
    interval_ms: body.intervalMs
  });

  const timer = setInterval(async () => {
    try {
      await doComputeTag(id);
    } catch (e) {}
  }, body.intervalMs);
  timer.unref();
  computedTagStore.setTimer(id, timer);

  setTimeout(async () => {
    try { await doComputeTag(id); } catch (e) {}
  }, 100);

  return { success: true, tag: await getTagById(id) };
}

async function getTagById(id) {
  const row = await get('SELECT * FROM computed_tags WHERE id = ?', [id]);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    expression: row.expression,
    sourceRegisters: JSON.parse(row.source_registers),
    intervalMs: row.interval_ms,
    currentValue: row.current_value
  };
}

function getAllTags() {
  return computedTagStore.getAll();
}

async function getTagHistory(tagId, limit) {
  const lim = limit ? Math.min(parseInt(limit) || 100, 1000) : 100;
  const rows = await all(`SELECT value, timestamp FROM computed_tag_history
    WHERE tag_id = ? ORDER BY timestamp DESC LIMIT ?`, [tagId, lim]);
  return rows.reverse();
}

async function startAllComputedTags() {
  const rows = await all('SELECT * FROM computed_tags');
  for (const row of rows) {
    computedTagStore.addTag({
      id: row.id,
      name: row.name,
      expression: row.expression,
      sourceRegisters: JSON.parse(row.source_registers),
      interval_ms: row.interval_ms,
      currentValue: row.current_value
    });

    const timer = setInterval(async () => {
      try {
        await doComputeTag(row.id);
      } catch (e) {}
    }, row.interval_ms);
    timer.unref();
    computedTagStore.setTimer(row.id, timer);
  }
}

module.exports = {
  createTag,
  getTagById,
  getAllTags,
  getTagHistory,
  startAllComputedTags,
  doComputeTag,
  resolveReference
};
