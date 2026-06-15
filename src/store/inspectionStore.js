class InspectionStore {
  constructor() {
    this.generationTimer = null;
    this.overdueTimer = null;
  }

  setGenerationTimer(timer) {
    this.generationTimer = timer;
  }

  setOverdueTimer(timer) {
    this.overdueTimer = timer;
  }

  clearAllTimers() {
    if (this.generationTimer) {
      clearInterval(this.generationTimer);
      this.generationTimer = null;
    }
    if (this.overdueTimer) {
      clearInterval(this.overdueTimer);
      this.overdueTimer = null;
    }
  }
}

module.exports = new InspectionStore();
