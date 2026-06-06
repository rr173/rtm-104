const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');

const TYPE_RANGES = {
  int16: { min: -32768, max: 32767 },
  uint16: { min: 0, max: 65535 },
  int32: { min: -2147483648, max: 2147483647 },
  float32: { min: -3.402823466e+38, max: 3.402823466e+38 }
};

function validateRecipeInput(body) {
  if (!body.name || typeof body.name !== 'string') {
    return '配方名称不能为空';
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return '配方至少包含一个寄存器项';
  }
  const keySet = new Set();
  for (const item of body.items) {
    if (!item.deviceId || typeof item.deviceId !== 'string') {
      return '每个配方项必须指定deviceId';
    }
    if (typeof item.address !== 'number' || item.address < 0) {
      return '寄存器地址必须是非负整数';
    }
    if (typeof item.value !== 'number' || isNaN(item.value)) {
      return '寄存器值必须是有效数字';
    }
    const key = `${item.deviceId}:${item.address}`;
    if (keySet.has(key)) {
      return `同一配方中存在重复项: 设备${item.deviceId} 地址${item.address}`;
    }
    keySet.add(key);
  }
  return null;
}

async function validateItemAgainstRegister(item) {
  const reg = await get(
    'SELECT * FROM registers WHERE device_id = ? AND address = ?',
    [item.deviceId, item.address]
  );
  if (!reg) {
    return { valid: false, error: `寄存器不存在: 设备${item.deviceId} 地址${item.address}` };
  }
  if (reg.rw !== 'RW') {
    return { valid: false, error: `寄存器为只读: 设备${item.deviceId} 地址${item.address} (${reg.name})` };
  }
  if (!deviceStore.hasDevice(item.deviceId)) {
    return { valid: false, error: `设备未初始化: ${item.deviceId}` };
  }
  const status = deviceStore.getStatus(item.deviceId);
  if (status && status !== 'online') {
    return { valid: false, error: `设备离线: ${item.deviceId} (状态: ${status})` };
  }
  const range = TYPE_RANGES[reg.data_type];
  if (range) {
    if (item.value < range.min || item.value > range.max) {
      return {
        valid: false,
        error: `值超出范围: ${reg.name}=${item.value}, 允许范围[${range.min}, ${range.max}]`
      };
    }
  }
  return { valid: true, reg };
}

async function createRecipe(body) {
  const err = validateRecipeInput(body);
  if (err) {
    return { success: false, error: err };
  }

  for (const item of body.items) {
    const vr = await validateItemAgainstRegister(item);
    if (!vr.valid) {
      return { success: false, error: vr.error };
    }
  }

  const id = uuidv4();
  const now = Date.now();

  await run('INSERT INTO recipes (id, name, description, created_at) VALUES (?, ?, ?, ?)',
    [id, body.name, body.description || null, now]);

  for (const item of body.items) {
    await run('INSERT INTO recipe_items (recipe_id, device_id, address, value) VALUES (?, ?, ?, ?)',
      [id, item.deviceId, item.address, item.value]);
  }

  return { success: true, recipe: await getRecipeById(id) };
}

async function getRecipeById(id) {
  const recipe = await get('SELECT * FROM recipes WHERE id = ?', [id]);
  if (!recipe) return null;

  const items = await all('SELECT device_id, address, value FROM recipe_items WHERE recipe_id = ?', [id]);
  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    createdAt: recipe.created_at,
    items: items.map(it => ({
      deviceId: it.device_id,
      address: it.address,
      value: it.value
    }))
  };
}

async function getAllRecipes() {
  const recipes = await all('SELECT * FROM recipes ORDER BY created_at');
  const result = [];
  for (const r of recipes) {
    const items = await all('SELECT device_id, address, value FROM recipe_items WHERE recipe_id = ?', [r.id]);
    result.push({
      id: r.id,
      name: r.name,
      description: r.description,
      createdAt: r.created_at,
      items: items.map(it => ({
        deviceId: it.device_id,
        address: it.address,
        value: it.value
      }))
    });
  }
  return result;
}

async function updateRecipe(id, body) {
  const existing = await get('SELECT id FROM recipes WHERE id = ?', [id]);
  if (!existing) {
    return { success: false, error: '配方不存在' };
  }

  const err = validateRecipeInput(body);
  if (err) {
    return { success: false, error: err };
  }

  for (const item of body.items) {
    const vr = await validateItemAgainstRegister(item);
    if (!vr.valid) {
      return { success: false, error: vr.error };
    }
  }

  await run('UPDATE recipes SET name = ?, description = ? WHERE id = ?',
    [body.name, body.description || null, id]);

  await run('DELETE FROM recipe_items WHERE recipe_id = ?', [id]);
  for (const item of body.items) {
    await run('INSERT INTO recipe_items (recipe_id, device_id, address, value) VALUES (?, ?, ?, ?)',
      [id, item.deviceId, item.address, item.value]);
  }

  return { success: true, recipe: await getRecipeById(id) };
}

async function deleteRecipe(id) {
  const existing = await get('SELECT id FROM recipes WHERE id = ?', [id]);
  if (!existing) return false;

  await run('DELETE FROM recipe_items WHERE recipe_id = ?', [id]);
  await run('DELETE FROM recipes WHERE id = ?', [id]);
  return true;
}

async function applyRecipe(id) {
  const recipe = await getRecipeById(id);
  if (!recipe) {
    return { success: false, error: '配方不存在' };
  }

  const executionId = uuidv4();
  const executedAt = Date.now();

  const validatedItems = [];
  const preValidationErrors = [];
  for (const item of recipe.items) {
    const vr = await validateItemAgainstRegister(item);
    if (!vr.valid) {
      preValidationErrors.push({ item, error: vr.error });
    } else {
      validatedItems.push({ ...item, dataType: vr.reg.data_type });
    }
  }

  if (preValidationErrors.length > 0) {
    await recordExecution(executionId, recipe, 'failed', executedAt,
      preValidationErrors.map(e => e.error).join('; '), 0,
      recipe.items.map(it => ({
        ...it,
        originalValue: 0,
        finalValue: 0,
        writeStatus: 'skipped'
      }))
    );
    return {
      success: false,
      error: preValidationErrors[0].error,
      phase: 'validate',
      executionId
    };
  }

  const snapshots = [];
  for (const item of validatedItems) {
    const { value } = deviceStore.getRegisterValue(item.deviceId, item.address, item.dataType);
    snapshots.push({ ...item, originalValue: value });
  }

  const writeResults = [];
  const written = [];
  let failedItem = null;
  let firstError = null;

  for (const snap of snapshots) {
    const status = deviceStore.getStatus(snap.deviceId);
    if (status && status !== 'online') {
      failedItem = { deviceId: snap.deviceId, address: snap.address, value: snap.value };
      firstError = `设备离线: ${snap.deviceId} (状态: ${status})`;
      writeResults.push({ ...snap, finalValue: snap.originalValue, writeStatus: 'failed' });
      break;
    }

    try {
      const ok = deviceStore.setRegisterValue(snap.deviceId, snap.address, snap.dataType, snap.value);
      if (!ok) {
        throw new Error(`写入失败: 设备${snap.deviceId} 地址${snap.address}`);
      }
      written.push(snap);
      writeResults.push({ ...snap, finalValue: snap.value, writeStatus: 'written' });
    } catch (e) {
      failedItem = { deviceId: snap.deviceId, address: snap.address, value: snap.value };
      firstError = e.message;
      writeResults.push({ ...snap, finalValue: snap.originalValue, writeStatus: 'failed' });
      break;
    }
  }

  let rolledBack = 0;
  if (failedItem) {
    for (let i = written.length - 1; i >= 0; i--) {
      const w = written[i];
      try {
        deviceStore.setRegisterValue(w.deviceId, w.address, w.dataType, w.originalValue);
        rolledBack++;
        const wr = writeResults.find(r => r.deviceId === w.deviceId && r.address === w.address);
        if (wr) {
          wr.finalValue = w.originalValue;
          wr.writeStatus = 'rolled_back';
        }
      } catch (e) {
        console.error(`回滚失败: 设备${w.deviceId} 地址${w.address}`, e.message);
      }
    }

    await recordExecution(executionId, recipe, 'failed', executedAt, firstError, rolledBack, writeResults);

    return {
      success: false,
      error: `下发失败: ${firstError}，已回滚${rolledBack}项`,
      phase: 'write',
      failedItem,
      rolledBack,
      executionId
    };
  }

  await recordExecution(executionId, recipe, 'success', executedAt, null, 0, writeResults);

  return {
    success: true,
    appliedCount: validatedItems.length,
    executionId,
    items: validatedItems.map(it => ({
      deviceId: it.deviceId,
      address: it.address,
      value: it.value
    }))
  };
}

async function recordExecution(executionId, recipe, status, executedAt, error, rolledBack, itemResults) {
  try {
    await run(
      'INSERT INTO recipe_executions (id, recipe_id, recipe_name, status, executed_at, error, rolled_back) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [executionId, recipe.id, recipe.name, status, executedAt, error || null, rolledBack || 0]
    );
    for (const it of itemResults) {
      await run(
        'INSERT INTO recipe_execution_items (execution_id, device_id, address, target_value, original_value, final_value, write_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          executionId,
          it.deviceId,
          it.address,
          it.value,
          it.originalValue,
          it.finalValue,
          it.writeStatus
        ]
      );
    }
  } catch (e) {
    console.error('记录配方下发历史失败:', e.message);
  }
}

async function getExecutionHistory(limit) {
  const lim = Math.min(parseInt(limit) || 100, 1000);
  const executions = await all(
    'SELECT * FROM recipe_executions ORDER BY executed_at DESC LIMIT ?',
    [lim]
  );
  const result = [];
  for (const e of executions) {
    const items = await all(
      'SELECT device_id, address, target_value, original_value, final_value, write_status FROM recipe_execution_items WHERE execution_id = ?',
      [e.id]
    );
    result.push({
      id: e.id,
      recipeId: e.recipe_id,
      recipeName: e.recipe_name,
      status: e.status,
      executedAt: e.executed_at,
      error: e.error,
      rolledBack: e.rolled_back,
      items: items.map(it => ({
        deviceId: it.device_id,
        address: it.address,
        targetValue: it.target_value,
        originalValue: it.original_value,
        finalValue: it.final_value,
        writeStatus: it.write_status
      }))
    });
  }
  return result;
}

async function getRecipeExecutions(recipeId, limit) {
  const lim = Math.min(parseInt(limit) || 100, 1000);
  const executions = await all(
    'SELECT * FROM recipe_executions WHERE recipe_id = ? ORDER BY executed_at DESC LIMIT ?',
    [recipeId, lim]
  );
  const result = [];
  for (const e of executions) {
    const items = await all(
      'SELECT device_id, address, target_value, original_value, final_value, write_status FROM recipe_execution_items WHERE execution_id = ?',
      [e.id]
    );
    result.push({
      id: e.id,
      recipeId: e.recipe_id,
      recipeName: e.recipe_name,
      status: e.status,
      executedAt: e.executed_at,
      error: e.error,
      rolledBack: e.rolled_back,
      items: items.map(it => ({
        deviceId: it.device_id,
        address: it.address,
        targetValue: it.target_value,
        originalValue: it.original_value,
        finalValue: it.final_value,
        writeStatus: it.write_status
      }))
    });
  }
  return result;
}

async function validateRecipe(id) {
  const recipe = await getRecipeById(id);
  if (!recipe) {
    return { success: false, error: '配方不存在' };
  }

  const results = [];
  let allValid = true;
  for (const item of recipe.items) {
    const vr = await validateItemAgainstRegister(item);
    const reg = vr.reg ? { name: vr.reg.name, dataType: vr.reg.data_type, rw: vr.reg.rw } : null;
    results.push({
      deviceId: item.deviceId,
      address: item.address,
      value: item.value,
      valid: vr.valid,
      error: vr.error || null,
      register: reg
    });
    if (!vr.valid) allValid = false;
  }

  return { success: true, valid: allValid, results };
}

module.exports = {
  createRecipe,
  getRecipeById,
  getAllRecipes,
  updateRecipe,
  deleteRecipe,
  applyRecipe,
  validateRecipe,
  getExecutionHistory,
  getRecipeExecutions
};
