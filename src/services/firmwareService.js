const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../db/database');
const firmwareStore = require('../store/firmwareStore');
const otaStore = require('../store/otaStore');
const crypto = require('crypto');

function validateVersion(version) {
  if (!version || typeof version !== 'string') {
    return '版本号不能为空';
  }
  const semverRegex = /^\d+\.\d+\.\d+$/;
  if (!semverRegex.test(version)) {
    return '版本号格式必须为x.y.z（如1.0.0）';
  }
  return null;
}

async function loadFirmwareFromDB() {
  const rows = await all('SELECT * FROM firmware ORDER BY uploaded_at');
  for (const row of rows) {
    firmwareStore.addFirmware(
      row.id,
      row.version,
      row.description,
      row.file_size,
      row.checksum,
      row.uploaded_at
    );
  }
  return rows.length;
}

async function uploadFirmware(body) {
  const { version, description, fileSize } = body;

  const versionError = validateVersion(version);
  if (versionError) {
    return { success: false, error: versionError };
  }

  if (firmwareStore.hasVersion(version)) {
    return { success: false, error: `版本号 ${version} 已存在，不允许重复上传` };
  }

  const id = uuidv4();
  const now = Date.now();
  const size = typeof fileSize === 'number' ? fileSize : Math.floor(Math.random() * 5000000) + 500000;
  const checksum = crypto.createHash('md5').update(version + now).digest('hex');
  const desc = description || `固件版本 ${version}`;

  await run(
    'INSERT INTO firmware (id, version, description, file_size, checksum, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, version, desc, size, checksum, now]
  );

  firmwareStore.addFirmware(id, version, desc, size, checksum, now);

  return { success: true, firmware: await getFirmwareById(id) };
}

async function getFirmwareById(id) {
  const fw = firmwareStore.getFirmware(id);
  if (fw) {
    return { ...fw };
  }
  const row = await get('SELECT * FROM firmware WHERE id = ?', [id]);
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    description: row.description,
    fileSize: row.file_size,
    checksum: row.checksum,
    uploadedAt: row.uploaded_at
  };
}

async function getFirmwareByVersion(version) {
  const fw = firmwareStore.getFirmwareByVersion(version);
  if (fw) return { ...fw };
  const row = await get('SELECT * FROM firmware WHERE version = ?', [version]);
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    description: row.description,
    fileSize: row.file_size,
    checksum: row.checksum,
    uploadedAt: row.uploaded_at
  };
}

async function getAllFirmware() {
  const fromStore = firmwareStore.getAllFirmware();
  if (fromStore.length > 0) {
    return fromStore.map(fw => ({ ...fw }));
  }
  const rows = await all('SELECT * FROM firmware ORDER BY uploaded_at');
  return rows.map(row => ({
    id: row.id,
    version: row.version,
    description: row.description,
    fileSize: row.file_size,
    checksum: row.checksum,
    uploadedAt: row.uploaded_at
  }));
}

function isFirmwareInUse(firmwareId) {
  for (const upgrade of otaStore.getAllActiveUpgrades()) {
    if (upgrade.firmwareId === firmwareId) {
      return true;
    }
  }
  return false;
}

async function deleteFirmware(id) {
  if (!firmwareStore.hasFirmware(id)) {
    const row = await get('SELECT id FROM firmware WHERE id = ?', [id]);
    if (!row) {
      return { success: false, error: '固件版本不存在' };
    }
  }

  if (isFirmwareInUse(id)) {
    return { success: false, error: '该固件版本正在被升级任务使用，不允许删除' };
  }

  await run('DELETE FROM firmware WHERE id = ?', [id]);
  firmwareStore.removeFirmware(id);
  return { success: true };
}

module.exports = {
  loadFirmwareFromDB,
  uploadFirmware,
  getFirmwareById,
  getFirmwareByVersion,
  getAllFirmware,
  deleteFirmware,
  isFirmwareInUse
};
