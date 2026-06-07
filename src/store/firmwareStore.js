class FirmwareStore {
  constructor() {
    this.firmware = new Map();
  }

  addFirmware(id, version, description, fileSize, checksum, uploadedAt) {
    this.firmware.set(id, {
      id,
      version,
      description,
      fileSize,
      checksum,
      uploadedAt
    });
  }

  hasFirmware(id) {
    return this.firmware.has(id);
  }

  hasVersion(version) {
    for (const fw of this.firmware.values()) {
      if (fw.version === version) return true;
    }
    return false;
  }

  getFirmware(id) {
    return this.firmware.get(id) || null;
  }

  getFirmwareByVersion(version) {
    for (const fw of this.firmware.values()) {
      if (fw.version === version) return fw;
    }
    return null;
  }

  getAllFirmware() {
    return Array.from(this.firmware.values());
  }

  removeFirmware(id) {
    this.firmware.delete(id);
  }
}

module.exports = new FirmwareStore();
