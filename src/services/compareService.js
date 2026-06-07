const { all } = require('../db/database');
const deviceStore = require('../store/deviceStore');

function computeStats(values) {
  if (!values || values.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0, count: 0 };
  }

  const count = values.length;
  let sum = 0;
  let min = values[0];
  let max = values[0];

  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const mean = sum / count;

  let varianceSum = 0;
  for (const v of values) {
    const diff = v - mean;
    varianceSum += diff * diff;
  }
  const stddev = Math.sqrt(varianceSum / count);

  return { mean, stddev, min, max, count };
}

function determineTrend(meanA, meanB) {
  if (meanB === 0) {
    if (meanA === 0) return '平稳';
    return meanA > 0 ? '上升' : '下降';
  }
  const diffPercent = ((meanA - meanB) / Math.abs(meanB)) * 100;
  if (diffPercent > 5) return '上升';
  if (diffPercent < -5) return '下降';
  return '平稳';
}

async function getHistoryValues(deviceId, regAddress, startTime, endTime) {
  const rows = await all(
    `SELECT value FROM register_history 
     WHERE device_id = ? AND reg_address = ? AND timestamp >= ? AND timestamp <= ?
     ORDER BY timestamp ASC`,
    [deviceId, regAddress, startTime, endTime]
  );
  return rows.map(r => r.value);
}

function validateCompareRequest(body) {
  if (!body.deviceId) return '缺少deviceId';
  if (!deviceStore.hasDevice(body.deviceId)) return '设备不存在';
  if (typeof body.regAddress !== 'number') return 'regAddress必须是数字';
  if (typeof body.startA !== 'number' || typeof body.endA !== 'number') {
    return '时间段A的startA和endA必须是数字时间戳';
  }
  if (typeof body.startB !== 'number' || typeof body.endB !== 'number') {
    return '时间段B的startB和endB必须是数字时间戳';
  }
  if (body.startA >= body.endA) return '时间段A的startA必须小于endA';
  if (body.startB >= body.endB) return '时间段B的startB必须小于endB';
  return null;
}

async function compare(body) {
  const err = validateCompareRequest(body);
  if (err) {
    return { success: false, error: err, code: 400 };
  }

  const [valuesA, valuesB] = await Promise.all([
    getHistoryValues(body.deviceId, body.regAddress, body.startA, body.endA),
    getHistoryValues(body.deviceId, body.regAddress, body.startB, body.endB)
  ]);

  const periodA = computeStats(valuesA);
  const periodB = computeStats(valuesB);

  const diff = {
    meanDiff: periodA.mean - periodB.mean,
    stddevDiff: periodA.stddev - periodB.stddev,
    maxDiff: periodA.max - periodB.max,
    minDiff: periodA.min - periodB.min,
    trendDirection: determineTrend(periodA.mean, periodB.mean)
  };

  return {
    success: true,
    periodA,
    periodB,
    diff
  };
}

module.exports = {
  compare
};
