class EnergyStore {
  constructor() {
    this.timer = null;
    this.intervalMs = 10000;
    this.lastSampleTime = {};
    this.lastPowerValue = {};
  }

  setTimer(timer) {
    this.timer = timer;
  }

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setLastSample(deviceId, timestamp) {
    this.lastSampleTime[deviceId] = timestamp;
  }

  getLastSample(deviceId) {
    return this.lastSampleTime[deviceId] || null;
  }

  setLastPower(deviceId, address, value) {
    const key = `${deviceId}_${address}`;
    this.lastPowerValue[key] = value;
  }

  getLastPower(deviceId, address) {
    const key = `${deviceId}_${address}`;
    return this.lastPowerValue[key] !== undefined ? this.lastPowerValue[key] : null;
  }
}

module.exports = new EnergyStore();
