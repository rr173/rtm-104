class SequenceStore {
  constructor() {
    this.currentExecution = null;
    this.timer = null;
  }

  isRunning() {
    return this.currentExecution !== null &&
           (this.currentExecution.status === 'running' ||
            this.currentExecution.status === 'overridden' ||
            this.currentExecution.status === 'blocked');
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
      overridden: false,
      blocked: false,
      blockedSince: null,
      blockedReason: null
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

  markBlocked(reason) {
    if (this.currentExecution && this.currentExecution.status !== 'blocked') {
      this.currentExecution.blocked = true;
      this.currentExecution.blockedSince = Date.now();
      this.currentExecution.blockedReason = reason;
      if (this.currentExecution.status === 'running' || this.currentExecution.status === 'overridden') {
        this.currentExecution.prevStatus = this.currentExecution.status;
      }
      this.currentExecution.status = 'blocked';
    }
  }

  unblock() {
    if (this.currentExecution && this.currentExecution.status === 'blocked') {
      const blockedDuration = this.currentExecution.blockedSince
        ? (Date.now() - this.currentExecution.blockedSince)
        : 0;

      if (!this.currentExecution.totalBlockedMs) {
        this.currentExecution.totalBlockedMs = 0;
      }
      this.currentExecution.totalBlockedMs += blockedDuration;

      if (this.currentExecution.currentStep !== null) {
        const step = this.currentExecution.currentStep;
        if (this.currentExecution.stepHistory[step]) {
          const hist = this.currentExecution.stepHistory[step];
          if (!hist.blockedMs) hist.blockedMs = 0;
          hist.blockedMs += blockedDuration;
        }
      }

      this.currentExecution.blocked = false;
      this.currentExecution.blockedSince = null;
      this.currentExecution.blockedReason = null;
      this.currentExecution.status = this.currentExecution.prevStatus || 'running';
      delete this.currentExecution.prevStatus;
    }
  }

  isBlocked() {
    return this.currentExecution && this.currentExecution.status === 'blocked';
  }

  enterStep(stepNumber) {
    if (!this.currentExecution) return;
    this.currentExecution.currentStep = stepNumber;
    if (!this.currentExecution.stepHistory[stepNumber]) {
      this.currentExecution.stepHistory[stepNumber] = {};
    }
    this.currentExecution.stepHistory[stepNumber].enteredAt = Date.now();
    this.currentExecution.stepHistory[stepNumber].overridden = false;
    this.currentExecution.stepHistory[stepNumber].blocked = false;
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

  markStepBlocked(stepNumber, reason) {
    if (!this.currentExecution) return;
    if (this.currentExecution.stepHistory[stepNumber]) {
      this.currentExecution.stepHistory[stepNumber].blocked = true;
      this.currentExecution.stepHistory[stepNumber].blockedReason = reason;
      this.currentExecution.stepHistory[stepNumber].blockedAt = Date.now();
    }
    this.markBlocked(reason);
  }

  stopExecution() {
    this.currentExecution = null;
  }
}

module.exports = new SequenceStore();
