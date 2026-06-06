class TrendStore {
  constructor() {
    this.timers = new Map();
    this.stats = new Map();
    this.anomalyState = new Map();
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

  removeConfig(configId, deviceId, regAddress) {
    this.clearTimer(configId);
    this.stats.delete(configId);
    const key = `${deviceId}:${regAddress}`;
    this.anomalyState.delete(key);
  }
}

module.exports = new TrendStore();
