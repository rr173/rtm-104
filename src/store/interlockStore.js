class InterlockStore {
  constructor() {
    this.states = new Map();
    this.activeWrites = new Map();
    this.timer = null;
  }

  setState(id, state) {
    this.states.set(id, state);
  }

  getState(id) {
    return this.states.get(id) || 'normal';
  }

  getAllStates() {
    const result = {};
    for (const [id, state] of this.states.entries()) {
      result[id] = state;
    }
    return result;
  }

  getTriggeredInfo(id) {
    return this.states.get(id + '_info') || null;
  }

  setTriggeredInfo(id, info) {
    if (info) {
      this.states.set(id + '_info', info);
    } else {
      this.states.delete(id + '_info');
    }
  }

  recordWrite(interlockId, priority, deviceId, address, value, timestamp) {
    const key = `${deviceId}:${address}`;
    const existing = this.activeWrites.get(key);
    if (!existing ||
        priority > existing.priority ||
        (priority === existing.priority && timestamp >= existing.timestamp)) {
      this.activeWrites.set(key, { interlockId, priority, deviceId, address, value, timestamp });
      return true;
    }
    return false;
  }

  clearWritesForInterlock(interlockId) {
    for (const [key, w] of this.activeWrites.entries()) {
      if (w.interlockId === interlockId) {
        this.activeWrites.delete(key);
      }
    }
  }

  getActiveWrite(deviceId, address) {
    const key = `${deviceId}:${address}`;
    return this.activeWrites.get(key) || null;
  }

  getAllActiveWrites() {
    const result = [];
    for (const w of this.activeWrites.values()) {
      result.push(w);
    }
    return result;
  }
}

module.exports = new InterlockStore();
