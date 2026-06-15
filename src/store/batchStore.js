class BatchStore {
  constructor() {
    this.runningBatchId = null;
    this.lockedRegisters = new Map();
    this.samplingTimer = null;
    this.activeDeviations = new Map();
  }

  setRunningBatch(batchId, lockedRegs) {
    this.runningBatchId = batchId;
    this.lockedRegisters.clear();
    this.activeDeviations.clear();
    for (const reg of lockedRegs) {
      const key = `${reg.deviceId}:${reg.address}`;
      this.lockedRegisters.set(key, reg);
    }
  }

  clearRunningBatch() {
    this.runningBatchId = null;
    this.lockedRegisters.clear();
    this.activeDeviations.clear();
  }

  getRunningBatchId() {
    return this.runningBatchId;
  }

  isRegisterLocked(deviceId, address) {
    return this.lockedRegisters.has(`${deviceId}:${address}`);
  }

  isAnyRegisterLocked(deviceId, addresses) {
    for (const addr of addresses) {
      if (this.lockedRegisters.has(`${deviceId}:${addr}`)) {
        return true;
      }
    }
    return false;
  }

  getLockedRegistersList() {
    return Array.from(this.lockedRegisters.values());
  }

  hasRunningBatch() {
    return this.runningBatchId !== null;
  }

  setSamplingTimer(timer) {
    if (this.samplingTimer) {
      clearInterval(this.samplingTimer);
    }
    this.samplingTimer = timer;
  }

  clearSamplingTimer() {
    if (this.samplingTimer) {
      clearInterval(this.samplingTimer);
      this.samplingTimer = null;
    }
  }

  setActiveDeviation(deviceId, address, deviation) {
    const key = `${deviceId}:${address}`;
    this.activeDeviations.set(key, deviation);
  }

  getActiveDeviation(deviceId, address) {
    const key = `${deviceId}:${address}`;
    return this.activeDeviations.get(key) || null;
  }

  clearActiveDeviation(deviceId, address) {
    const key = `${deviceId}:${address}`;
    this.activeDeviations.delete(key);
  }

  hasActiveDeviation(deviceId, address) {
    const key = `${deviceId}:${address}`;
    return this.activeDeviations.has(key);
  }

  getAllActiveDeviations() {
    return Array.from(this.activeDeviations.entries()).map(([key, value]) => {
      const [deviceId, address] = key.split(':');
      return {
        deviceId,
        address: parseInt(address),
        ...value
      };
    });
  }

  getMonitoredRegisters() {
    return Array.from(this.lockedRegisters.values()).filter(
      reg => reg.upperLimit !== undefined && reg.lowerLimit !== undefined
    );
  }
}

module.exports = new BatchStore();
