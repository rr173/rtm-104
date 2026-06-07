class OtaStore {
  constructor() {
    this.activeUpgrades = new Map();
  }

  startUpgrade(deviceId, upgradeId, firmwareId, firmwareVersion) {
    this.activeUpgrades.set(deviceId, {
      upgradeId,
      deviceId,
      firmwareId,
      firmwareVersion,
      status: 'upgrading',
      stage: 'download',
      progress: 0,
      startedAt: Date.now(),
      stageTimer: null
    });
  }

  hasActiveUpgrade(deviceId) {
    return this.activeUpgrades.has(deviceId);
  }

  getActiveUpgrade(deviceId) {
    return this.activeUpgrades.get(deviceId) || null;
  }

  updateStage(deviceId, stage, progress) {
    const upgrade = this.activeUpgrades.get(deviceId);
    if (upgrade) {
      upgrade.stage = stage;
      upgrade.progress = progress;
    }
  }

  completeUpgrade(deviceId) {
    this.activeUpgrades.delete(deviceId);
  }

  failUpgrade(deviceId, errorMessage) {
    const upgrade = this.activeUpgrades.get(deviceId);
    if (upgrade) {
      upgrade.status = 'failed';
      upgrade.errorMessage = errorMessage;
    }
    this.activeUpgrades.delete(deviceId);
  }

  setStageTimer(deviceId, timer) {
    const upgrade = this.activeUpgrades.get(deviceId);
    if (upgrade) {
      upgrade.stageTimer = timer;
    }
  }

  clearStageTimer(deviceId) {
    const upgrade = this.activeUpgrades.get(deviceId);
    if (upgrade && upgrade.stageTimer) {
      clearTimeout(upgrade.stageTimer);
      upgrade.stageTimer = null;
    }
  }

  clearAllTimers() {
    for (const upgrade of this.activeUpgrades.values()) {
      if (upgrade.stageTimer) {
        clearTimeout(upgrade.stageTimer);
      }
    }
    this.activeUpgrades.clear();
  }

  getAllActiveUpgrades() {
    return Array.from(this.activeUpgrades.values());
  }
}

module.exports = new OtaStore();
