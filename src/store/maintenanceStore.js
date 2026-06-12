class MaintenanceStore {
  constructor() {
    this.lockedDevices = new Map();
    this.scanTimer = null;
  }

  lockDevice(deviceId, orderId) {
    this.lockedDevices.set(deviceId, {
      locked: true,
      orderId,
      lockedAt: Date.now()
    });
  }

  unlockDevice(deviceId) {
    this.lockedDevices.delete(deviceId);
  }

  isDeviceLocked(deviceId) {
    return this.lockedDevices.has(deviceId);
  }

  getLockInfo(deviceId) {
    const info = this.lockedDevices.get(deviceId);
    if (!info) return null;
    return {
      locked: true,
      orderId: info.orderId,
      lockedAt: info.lockedAt,
      durationMs: Date.now() - info.lockedAt
    };
  }

  getAllLockedDevices() {
    const result = [];
    for (const [deviceId, info] of this.lockedDevices.entries()) {
      result.push({
        deviceId,
        orderId: info.orderId,
        lockedAt: info.lockedAt,
        durationMs: Date.now() - info.lockedAt
      });
    }
    return result;
  }

  clearTimer() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  setTimer(timer) {
    this.scanTimer = timer;
  }

  clearAllTimers() {
    this.clearTimer();
  }
}

module.exports = new MaintenanceStore();
