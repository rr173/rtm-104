class ShiftDutyStore {
  constructor() {
    this.currentLogId = null;
    this.currentShiftId = null;
    this.currentShiftName = null;
    this.currentShiftDate = null;
    this.scanTimer = null;
    this.timeoutFlags = new Map();
  }

  setCurrentLog(logId, shiftId, shiftName, shiftDate) {
    this.currentLogId = logId;
    this.currentShiftId = shiftId;
    this.currentShiftName = shiftName;
    this.currentShiftDate = shiftDate;
  }

  getCurrentLogId() {
    return this.currentLogId;
  }

  getCurrentShiftInfo() {
    return {
      logId: this.currentLogId,
      shiftId: this.currentShiftId,
      shiftName: this.currentShiftName,
      shiftDate: this.currentShiftDate
    };
  }

  clearCurrentLog() {
    this.currentLogId = null;
    this.currentShiftId = null;
    this.currentShiftName = null;
    this.currentShiftDate = null;
  }

  setTimeoutFlag(logId) {
    this.timeoutFlags.set(logId, true);
  }

  hasTimeoutFlag(logId) {
    return this.timeoutFlags.has(logId);
  }

  clearTimeoutFlag(logId) {
    this.timeoutFlags.delete(logId);
  }

  setScanTimer(timer) {
    this.scanTimer = timer;
  }

  clearScanTimer() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  clearAllTimers() {
    this.clearScanTimer();
  }
}

module.exports = new ShiftDutyStore();
