class AlarmStateStore {
  constructor() {
    this.pending = new Map();
  }

  setPending(ruleId, state) {
    this.pending.set(ruleId, state);
  }

  getPending(ruleId) {
    return this.pending.get(ruleId) || null;
  }

  clearPending(ruleId) {
    this.pending.delete(ruleId);
  }
}

module.exports = new AlarmStateStore();
