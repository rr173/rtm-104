const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const deviceStore = require('../store/deviceStore');
const pollingStore = require('../store/pollingStore');
const { getRegisterSpan } = require('../utils/modbus');

function validateRegister(reg) {
  if (typeof reg.address !== 'number' || reg.address < 0 || reg.address > 65535) {
    return '寄存器地址必须在0-65535之间';
  }
  if (!['int16', 'uint16', 'int32', 'float32'].includes(reg.dataType)) {
    return '数据类型必须是int16/uint16/int32/float32之一';
  }
  if (!['RO', 'RW'].includes(reg.rw)) {
    return '读写属性必须是RO或RW';
  }
  if (!reg.name || typeof reg.name !== 'string') {
    return '寄存器名称不能为空';
  }
  return null;
}

function validateDeviceInput(body) {
  if (!body.name || typeof body.name !== 'string') {
    return '设备名称不能为空';
  }
  if (typeof body.slaveId !== 'number' || body.slaveId < 1 || body.slaveId > 247) {
    return 'Modbus站号必须在1-247之间';
  }
  if (!Array.isArray(body.registers) || body.registers.length === 0) {
    return '寄存器定义列表不能为空';
  }

  const addrSet = new Set();
  for (const reg of body.registers) {
    const err = validateRegister(reg);
    if (err) return err;

    const span = getRegisterSpan(reg.dataType);
    for (let i = 0; i < span; i++) {
      const a = reg.address + i;
      if (addrSet.has(a)) {
        return `寄存器地址冲突: ${a}`;
      }
      addrSet.add(a);
    }
  }

  if (addrSet.size > 1000) {
    return '寄存器总数超过1000限制';
  }

  return null;
}

async function createDevice(body) {
  const err = validateDeviceInput(body);
  if (err) {
    return { success: false, error: err };
  }

  const id = uuidv4();
  const now = Date.now();

  await run('INSERT INTO devices (id, name, slave_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, body.name, body.slaveId, 'online', now]);

  for (const reg of body.registers) {
    await run(`INSERT INTO registers (device_id, address, name, data_type, rw, unit, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, reg.address, reg.name, reg.dataType, reg.rw, reg.unit || null, reg.description || null]);
  }

  deviceStore.addDevice(id, body.registers);
  pollingStore.initDevice(id);

  return { success: true, device: await getDeviceById(id) };
}

async function getDeviceById(id) {
  const dev = await get('SELECT * FROM devices WHERE id = ?', [id]);
  if (!dev) return null;

  const registers = await all('SELECT * FROM registers WHERE device_id = ? ORDER BY address', [id]);
  return {
    id: dev.id,
    name: dev.name,
    slaveId: dev.slave_id,
    status: deviceStore.getStatus(id) || dev.status,
    createdAt: dev.created_at,
    registers
  };
}

async function getDeviceDetail(id) {
  const dev = await getDeviceById(id);
  if (!dev) return null;

  const registerValues = deviceStore.getAllRegisterValues(id, dev.registers);
  return {
    id: dev.id,
    name: dev.name,
    slaveId: dev.slaveId,
    status: dev.status,
    createdAt: dev.createdAt,
    registers: registerValues
  };
}

async function getAllDevices() {
  const devices = await all('SELECT * FROM devices ORDER BY created_at');
  return devices.map(d => ({
    id: d.id,
    name: d.name,
    slaveId: d.slave_id,
    status: deviceStore.getStatus(d.id) || d.status,
    createdAt: d.created_at
  }));
}

async function deleteDevice(id) {
  const dev = await get('SELECT id FROM devices WHERE id = ?', [id]);
  if (!dev) return false;

  await run('DELETE FROM devices WHERE id = ?', [id]);
  deviceStore.removeDevice(id);
  pollingStore.removeDevice(id);
  return true;
}

async function writeRegister(deviceId, address, value) {
  const reg = await get('SELECT * FROM registers WHERE device_id = ? AND address = ?', [deviceId, address]);
  if (!reg) {
    return { success: false, error: '寄存器不存在' };
  }
  if (reg.rw !== 'RW') {
    return { success: false, error: '该寄存器为只读' };
  }

  deviceStore.setRegisterValue(deviceId, address, reg.data_type, value);
  return { success: true, value };
}

async function writeMultipleRegisters(deviceId, writes) {
  for (const w of writes) {
    const result = await writeRegister(deviceId, w.address, w.value);
    if (!result.success) return result;
  }
  return { success: true };
}

async function simulateRegisterValue(deviceId, address, value) {
  const reg = await get('SELECT * FROM registers WHERE device_id = ? AND address = ?', [deviceId, address]);
  if (!reg) {
    return { success: false, error: '寄存器不存在' };
  }
  deviceStore.setRegisterValue(deviceId, address, reg.data_type, value);
  return { success: true, value };
}

function simulateFault(deviceId, times) {
  if (!deviceStore.hasDevice(deviceId)) {
    return { success: false, error: '设备不存在' };
  }
  if (typeof times !== 'number' || times < 1) {
    return { success: false, error: '故障次数必须大于0' };
  }
  deviceStore.setFaultRemaining(deviceId, times);
  return { success: true };
}

function setDeviceStatus(deviceId, status) {
  if (!deviceStore.hasDevice(deviceId)) {
    return { success: false, error: '设备不存在' };
  }
  if (!['online', 'offline', 'fault'].includes(status)) {
    return { success: false, error: '状态必须是online/offline/fault之一' };
  }
  deviceStore.setStatus(deviceId, status);
  return { success: true };
}

async function getDeviceRegisters(deviceId) {
  return await all('SELECT * FROM registers WHERE device_id = ? ORDER BY address', [deviceId]);
}

module.exports = {
  createDevice,
  getDeviceById,
  getDeviceDetail,
  getAllDevices,
  deleteDevice,
  writeRegister,
  writeMultipleRegisters,
  simulateRegisterValue,
  simulateFault,
  setDeviceStatus,
  getDeviceRegisters
};
