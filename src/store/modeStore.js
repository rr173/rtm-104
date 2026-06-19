class ModeStore {
  constructor() {
    this.deviceModes = new Map();
    this.modeRegisters = new Map();
    this.modeAlarmOverrides = new Map();
    this.deviceActiveMode = new Map();
  }

  addMode(modeId, deviceId, name, precondition) {
    this.deviceModes.set(modeId, { modeId, deviceId, name, precondition });
    if (!this.modeRegisters.has(modeId)) {
      this.modeRegisters.set(modeId, []);
    }
    if (!this.modeAlarmOverrides.has(modeId)) {
      this.modeAlarmOverrides.set(modeId, []);
    }
  }

  removeMode(modeId) {
    this.deviceModes.delete(modeId);
    this.modeRegisters.delete(modeId);
    this.modeAlarmOverrides.delete(modeId);
  }

  getMode(modeId) {
    return this.deviceModes.get(modeId) || null;
  }

  getModesByDevice(deviceId) {
    const result = [];
    for (const [, mode] of this.deviceModes) {
      if (mode.deviceId === deviceId) {
        result.push(mode);
      }
    }
    return result;
  }

  setModeRegisters(modeId, registers) {
    this.modeRegisters.set(modeId, registers);
  }

  getModeRegisters(modeId) {
    return this.modeRegisters.get(modeId) || [];
  }

  setModeAlarmOverrides(modeId, overrides) {
    this.modeAlarmOverrides.set(modeId, overrides);
  }

  getModeAlarmOverrides(modeId) {
    return this.modeAlarmOverrides.get(modeId) || [];
  }

  setActiveMode(deviceId, modeId, lockedRegisters, savedRegisterValues, savedAlarmThresholds, enteredAt) {
    this.deviceActiveMode.set(deviceId, {
      modeId,
      lockedRegisters,
      savedRegisterValues,
      savedAlarmThresholds,
      enteredAt: enteredAt || Date.now()
    });
  }

  clearActiveMode(deviceId) {
    this.deviceActiveMode.delete(deviceId);
  }

  getActiveMode(deviceId) {
    return this.deviceActiveMode.get(deviceId) || null;
  }

  isRegisterLocked(deviceId, address) {
    const active = this.deviceActiveMode.get(deviceId);
    if (!active) return false;
    return active.lockedRegisters.some(r => r.address === address);
  }

  getLockedRegisters(deviceId) {
    const active = this.deviceActiveMode.get(deviceId);
    if (!active) return [];
    return active.lockedRegisters;
  }

  getAllLockedDeviceRegisters() {
    const result = [];
    for (const [deviceId, active] of this.deviceActiveMode) {
      for (const reg of active.lockedRegisters) {
        result.push({ deviceId, address: reg.address, modeId: active.modeId });
      }
    }
    return result;
  }

  hasDevice(deviceId) {
    for (const [, mode] of this.deviceModes) {
      if (mode.deviceId === deviceId) return true;
    }
    return false;
  }
}

module.exports = new ModeStore();
