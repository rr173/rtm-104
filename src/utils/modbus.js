function uint16ToBytes(val) {
  const v = val & 0xFFFF;
  return [(v >> 8) & 0xFF, v & 0xFF];
}

function bytesToUint16(b1, b2) {
  return ((b1 & 0xFF) << 8) | (b2 & 0xFF);
}

function regsToInt32(high, low) {
  const val = (high << 16) | (low & 0xFFFF);
  if (val & 0x80000000) {
    return val - 0x100000000;
  }
  return val;
}

function int32ToRegs(val) {
  const v = val < 0 ? val + 0x100000000 : val;
  return {
    high: (v >> 16) & 0xFFFF,
    low: v & 0xFFFF
  };
}

function regsToFloat32(high, low) {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(high & 0xFFFF, 0);
  buf.writeUInt16BE(low & 0xFFFF, 2);
  return buf.readFloatBE(0);
}

function float32ToRegs(val) {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(val, 0);
  return {
    high: buf.readUInt16BE(0),
    low: buf.readUInt16BE(2)
  };
}

function readTypedValue(regs, address, dataType) {
  switch (dataType) {
    case 'int16': {
      const v = regs.get(address);
      if (v === undefined) return 0;
      return (v & 0x8000) ? v - 0x10000 : v;
    }
    case 'uint16':
      return regs.get(address) || 0;
    case 'int32': {
      const high = regs.get(address) || 0;
      const low = regs.get(address + 1) || 0;
      return regsToInt32(high, low);
    }
    case 'float32': {
      const high = regs.get(address) || 0;
      const low = regs.get(address + 1) || 0;
      return regsToFloat32(high, low);
    }
    default:
      return 0;
  }
}

function writeTypedValue(regs, address, dataType, value) {
  switch (dataType) {
    case 'int16': {
      const v = value < 0 ? value + 0x10000 : value;
      regs.set(address, v & 0xFFFF);
      break;
    }
    case 'uint16':
      regs.set(address, value & 0xFFFF);
      break;
    case 'int32': {
      const { high, low } = int32ToRegs(value);
      regs.set(address, high);
      regs.set(address + 1, low);
      break;
    }
    case 'float32': {
      const { high, low } = float32ToRegs(value);
      regs.set(address, high);
      regs.set(address + 1, low);
      break;
    }
  }
}

function getRegisterSpan(dataType) {
  return (dataType === 'int32' || dataType === 'float32') ? 2 : 1;
}

module.exports = {
  uint16ToBytes,
  bytesToUint16,
  regsToInt32,
  int32ToRegs,
  regsToFloat32,
  float32ToRegs,
  readTypedValue,
  writeTypedValue,
  getRegisterSpan
};
