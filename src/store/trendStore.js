class TrendStore {
  constructor() {
    this.timers = new Map();
    this.stats = new Map();
    this.anomalyState = new Map();
    this.normalBaselines = new Map();
    this.recoveryCounts = new Map();
  }

  setTimer(configId, timer) {
    this.timers.set(configId, timer);
  }

  clearTimer(configId) {
    const timer = this.timers.get(configId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(configId);
    }
  }

  clearAllTimers() {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  setStats(configId, stats) {
    this.stats.set(configId, stats);
  }

  getStats(configId) {
    return this.stats.get(configId) || null;
  }

  getAllStats() {
    const result = {};
    for (const [id, s] of this.stats.entries()) {
      result[id] = s;
    }
    return result;
  }

  isLastAnomaly(deviceId, regAddress) {
    const key = `${deviceId}:${regAddress}`;
    return !!this.anomalyState.get(key);
  }

  setAnomalyState(deviceId, regAddress, isAnomaly) {
    const key = `${deviceId}:${regAddress}`;
    this.anomalyState.set(key, isAnomaly);
  }

  setNormalBaseline(deviceId, regAddress, baseline) {
    const key = `${deviceId}:${regAddress}`;
    if (baseline) {
      this.normalBaselines.set(key, baseline);
    } else {
      this.normalBaselines.delete(key);
    }
  }

  getNormalBaseline(deviceId, regAddress) {
    const key = `${deviceId}:${regAddress}`;
    return this.normalBaselines.get(key) || null;
  }

  getRecoveryCount(deviceId, regAddress) {
    const key = `${deviceId}:${regAddress}`;
    return this.recoveryCounts.get(key) || 0;
  }

  setRecoveryCount(deviceId, regAddress, count) {
    const key = `${deviceId}:${regAddress}`;
    if (count > 0) {
      this.recoveryCounts.set(key, count);
    } else {
      this.recoveryCounts.delete(key);
    }
  }

  removeConfig(configId, deviceId, regAddress) {
    this.clearTimer(configId);
    this.stats.delete(configId);
    const key = `${deviceId}:${regAddress}`;
    this.anomalyState.delete(key);
    this.normalBaselines.delete(key);
    this.recoveryCounts.delete(key);
  }
}

module.exports = new TrendStore();
