const { readTypedValue, writeTypedValue } = require('../utils/modbus');

class DeviceStore {
  constructor() {
    this.devices = new Map();
  }

  addDevice(deviceId, registersDef) {
    const regSpace = new Map();
    for (let i = 0; i < 1000; i++) {
      regSpace.set(i, 0);
    }

    registersDef.forEach(reg => {
      writeTypedValue(regSpace, reg.address, reg.dataType, 0);
    });

    this.devices.set(deviceId, {
      registers: regSpace,
      status: 'online',
      staleMap: new Map(),
      lastValidSnapshot: null,
      simulatedFaultRemaining: 0
    });
  }

  hasDevice(deviceId) {
    return this.devices.has(deviceId);
  }

  removeDevice(deviceId) {
    this.devices.delete(deviceId);
  }

  getStatus(deviceId) {
    const d = this.devices.get(deviceId);
    return d ? d.status : null;
  }

  setStatus(deviceId, status) {
    const d = this.devices.get(deviceId);
    if (d) d.status = status;
  }

  getRegisterValue(deviceId, address, dataType) {
    const d = this.devices.get(deviceId);
    if (!d) return { value: 0, stale: true };
    const value = readTypedValue(d.registers, address, dataType);
    const stale = d.staleMap.get(address) || false;
    return { value, stale };
  }

  setRegisterValue(deviceId, address, dataType, value) {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    writeTypedValue(d.registers, address, dataType, value);
    d.staleMap.set(address, false);
    return true;
  }

  getRawRegister(deviceId, address) {
    const d = this.devices.get(deviceId);
    if (!d) return 0;
    return d.registers.get(address) || 0;
  }

  setRawRegister(deviceId, address, value) {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    d.registers.set(address, value & 0xFFFF);
    return true;
  }

  getAllRegisterValues(deviceId, registersDef) {
    const d = this.devices.get(deviceId);
    if (!d) return [];
    return registersDef.map(reg => {
      const { value, stale } = this.getRegisterValue(deviceId, reg.address, reg.dataType);
      return {
        address: reg.address,
        name: reg.name,
        dataType: reg.dataType,
        value,
        stale: stale || false,
        unit: reg.unit,
        description: reg.description,
        rw: reg.rw
      };
    });
  }

  takeSnapshot(deviceId, addresses) {
    const d = this.devices.get(deviceId);
    if (!d) return null;
    const snapshot = {};
    addresses.forEach(addr => {
      snapshot[addr] = d.registers.get(addr) || 0;
    });
    return snapshot;
  }

  markStale(deviceId, addresses) {
    const d = this.devices.get(deviceId);
    if (!d) return;
    addresses.forEach(addr => {
      d.staleMap.set(addr, true);
    });
  }

  clearStale(deviceId) {
    const d = this.devices.get(deviceId);
    if (!d) return;
    d.staleMap.clear();
  }

  setFaultRemaining(deviceId, n) {
    const d = this.devices.get(deviceId);
    if (!d) return;
    d.simulatedFaultRemaining = n;
  }

  consumeFault(deviceId) {
    const d = this.devices.get(deviceId);
    if (!d || d.simulatedFaultRemaining <= 0) return false;
    d.simulatedFaultRemaining--;
    return true;
  }

  hasFault(deviceId) {
    const d = this.devices.get(deviceId);
    return d && d.simulatedFaultRemaining > 0;
  }

  getDevices() {
    const result = [];
    for (const [id, d] of this.devices.entries()) {
      result.push({ id, status: d.status });
    }
    return result;
  }
}

module.exports = new DeviceStore();
