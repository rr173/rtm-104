class RedundancyStore {
  constructor() {
    this.groups = new Map();
    this.deviceToGroup = new Map();
    this.failbackTimers = new Map();
    this.scanTimer = null;
    this.manualOfflineDevices = new Set();
  }

  addGroup(group) {
    let parsedSyncRegisters = [];
    if (group.syncRegisters !== undefined && group.syncRegisters !== null) {
      if (typeof group.syncRegisters === 'string') {
        try {
          parsedSyncRegisters = JSON.parse(group.syncRegisters);
        } catch (e) {
          parsedSyncRegisters = [];
        }
      } else if (Array.isArray(group.syncRegisters)) {
        parsedSyncRegisters = group.syncRegisters;
      }
    }
    this.groups.set(group.id, {
      ...group,
      syncRegisters: parsedSyncRegisters
    });
    this.deviceToGroup.set(group.primaryDeviceId || group.primary_device_id, group.id);
    this.deviceToGroup.set(group.backupDeviceId || group.backup_device_id, group.id);
  }

  removeGroup(groupId) {
    const group = this.groups.get(groupId);
    if (group) {
      this.deviceToGroup.delete(group.primaryDeviceId || group.primary_device_id);
      this.deviceToGroup.delete(group.backupDeviceId || group.backup_device_id);
    }
    this.clearFailbackTimer(groupId);
    this.groups.delete(groupId);
  }

  getGroup(groupId) {
    return this.groups.get(groupId) || null;
  }

  getAllGroups() {
    return Array.from(this.groups.values());
  }

  getGroupByDevice(deviceId) {
    const groupId = this.deviceToGroup.get(deviceId);
    return groupId ? this.groups.get(groupId) : null;
  }

  getGroupByLogicalDevice(logicalDeviceId) {
    for (const group of this.groups.values()) {
      if (group.logicalDeviceId === logicalDeviceId || group.logical_device_id === logicalDeviceId) {
        return group;
      }
    }
    return null;
  }

  setCurrentPrimary(groupId, deviceId) {
    const group = this.groups.get(groupId);
    if (group) {
      group.currentPrimaryId = deviceId;
      group.current_primary_id = deviceId;
    }
  }

  setStatus(groupId, status) {
    const group = this.groups.get(groupId);
    if (group) {
      group.status = status;
    }
  }

  incrementFailoverCount(groupId) {
    const group = this.groups.get(groupId);
    if (group) {
      group.failoverCount = (group.failoverCount || 0) + 1;
      group.failover_count = group.failoverCount;
    }
  }

  setLastSwitch(groupId, reason) {
    const group = this.groups.get(groupId);
    if (group) {
      group.lastSwitchAt = Date.now();
      group.last_switch_at = group.lastSwitchAt;
      group.lastSwitchReason = reason;
      group.last_switch_reason = reason;
    }
  }

  setRecovered(groupId) {
    const group = this.groups.get(groupId);
    if (group) {
      group.recoveredAt = Date.now();
      group.recovered_at = group.recoveredAt;
    }
  }

  clearRecovered(groupId) {
    const group = this.groups.get(groupId);
    if (group) {
      group.recoveredAt = null;
      group.recovered_at = null;
    }
  }

  updateSyncRegisters(groupId, registers) {
    const group = this.groups.get(groupId);
    if (group) {
      group.syncRegisters = registers;
    }
  }

  isDeviceInRedundancy(deviceId) {
    return this.deviceToGroup.has(deviceId);
  }

  isCurrentPrimary(deviceId) {
    const group = this.getGroupByDevice(deviceId);
    if (!group) return false;
    return (group.currentPrimaryId || group.current_primary_id) === deviceId;
  }

  getActiveDeviceId(deviceId) {
    const group = this.getGroupByDevice(deviceId);
    if (!group) return deviceId;
    return group.currentPrimaryId || group.current_primary_id || deviceId;
  }

  getPeerDeviceId(deviceId) {
    const group = this.getGroupByDevice(deviceId);
    if (!group) return null;
    const primary = group.primaryDeviceId || group.primary_device_id;
    const backup = group.backupDeviceId || group.backup_device_id;
    return deviceId === primary ? backup : primary;
  }

  setManualOffline(deviceId, offline) {
    if (offline) {
      this.manualOfflineDevices.add(deviceId);
    } else {
      this.manualOfflineDevices.delete(deviceId);
    }
  }

  isManualOffline(deviceId) {
    return this.manualOfflineDevices.has(deviceId);
  }

  setFailbackTimer(groupId, timer) {
    this.clearFailbackTimer(groupId);
    this.failbackTimers.set(groupId, timer);
  }

  clearFailbackTimer(groupId) {
    const timer = this.failbackTimers.get(groupId);
    if (timer) {
      clearTimeout(timer);
      this.failbackTimers.delete(groupId);
    }
  }

  clearAllFailbackTimers() {
    for (const timer of this.failbackTimers.values()) {
      clearTimeout(timer);
    }
    this.failbackTimers.clear();
  }

  clearAllTimers() {
    this.clearAllFailbackTimers();
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  setScanTimer(timer) {
    this.scanTimer = timer;
  }
}

module.exports = new RedundancyStore();
