class PollingStatusStore {
  constructor() {
    this.status = new Map();
  }

  initDevice(deviceId) {
    if (!this.status.has(deviceId)) {
      this.status.set(deviceId, {
        deviceId,
        lastPollTime: null,
        successCount: 0,
        consecutiveFailures: 0,
        timer: null
      });
    }
  }

  recordSuccess(deviceId) {
    const s = this.status.get(deviceId);
    if (s) {
      s.lastPollTime = Date.now();
      s.successCount++;
      s.consecutiveFailures = 0;
    }
  }

  recordFailure(deviceId) {
    const s = this.status.get(deviceId);
    if (s) {
      s.lastPollTime = Date.now();
      s.consecutiveFailures++;
    }
  }

  getStatus(deviceId) {
    return this.status.get(deviceId) || null;
  }

  getAllStatus() {
    const result = [];
    for (const s of this.status.values()) {
      result.push({
        deviceId: s.deviceId,
        lastPollTime: s.lastPollTime,
        successCount: s.successCount,
        consecutiveFailures: s.consecutiveFailures
      });
    }
    return result;
  }

  setTimer(deviceId, timer) {
    const s = this.status.get(deviceId);
    if (s) {
      s.timer = timer;
    }
  }

  clearTimer(deviceId) {
    const s = this.status.get(deviceId);
    if (s && s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
  }

  clearAllTimers() {
    for (const s of this.status.values()) {
      if (s.timer) {
        clearInterval(s.timer);
        s.timer = null;
      }
    }
  }

  removeDevice(deviceId) {
    this.clearTimer(deviceId);
    this.status.delete(deviceId);
  }
}

module.exports = new PollingStatusStore();
