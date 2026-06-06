class SequenceStore {
  constructor() {
    this.currentExecution = null;
    this.timer = null;
  }

  isRunning() {
    return this.currentExecution !== null &&
           (this.currentExecution.status === 'running' ||
            this.currentExecution.status === 'overridden');
  }

  startExecution(sequenceId, sequenceName, steps) {
    const stepMap = {};
    for (const step of steps) {
      stepMap[step.stepNumber] = step;
    }
    this.currentExecution = {
      sequenceId,
      sequenceName,
      steps: stepMap,
      stepNumbers: steps.map(s => s.stepNumber).sort((a, b) => a - b),
      status: 'running',
      currentStep: null,
      startedAt: Date.now(),
      stepHistory: {},
      overridden: false
    };
    return this.currentExecution;
  }

  getExecution() {
    return this.currentExecution;
  }

  setStatus(status) {
    if (this.currentExecution) {
      this.currentExecution.status = status;
    }
  }

  markOverridden() {
    if (this.currentExecution) {
      this.currentExecution.overridden = true;
      if (this.currentExecution.status === 'running') {
        this.currentExecution.status = 'overridden';
      }
    }
  }

  enterStep(stepNumber) {
    if (!this.currentExecution) return;
    this.currentExecution.currentStep = stepNumber;
    if (!this.currentExecution.stepHistory[stepNumber]) {
      this.currentExecution.stepHistory[stepNumber] = {};
    }
    this.currentExecution.stepHistory[stepNumber].enteredAt = Date.now();
    this.currentExecution.stepHistory[stepNumber].overridden = false;
  }

  leaveStep(stepNumber) {
    if (!this.currentExecution) return;
    if (!this.currentExecution.stepHistory[stepNumber]) {
      this.currentExecution.stepHistory[stepNumber] = {};
    }
    this.currentExecution.stepHistory[stepNumber].leftAt = Date.now();
  }

  markStepOverridden(stepNumber) {
    if (!this.currentExecution) return;
    if (this.currentExecution.stepHistory[stepNumber]) {
      this.currentExecution.stepHistory[stepNumber].overridden = true;
    }
    this.markOverridden();
  }

  stopExecution() {
    this.currentExecution = null;
  }
}

module.exports = new SequenceStore();
