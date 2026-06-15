class BatchStore {
  constructor() {
    this.runningBatchId = null;
    this.lockedRegisters = new Map();
    this.samplingTimer = null;
  }

  setRunningBatch(batchId, lockedRegs) {
    this.runningBatchId = batchId;
    this.lockedRegisters.clear();
    for (const reg of lockedRegs) {
      const key = `${reg.deviceId}:${reg.address}`;
      this.lockedRegisters.set(key, reg);
    }
  }

  clearRunningBatch() {
    this.runningBatchId = null;
    this.lockedRegisters.clear();
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
}

module.exports = new BatchStore();
