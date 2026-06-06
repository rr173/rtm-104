const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/gateway.db');

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function serialize(fn) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      Promise.resolve(fn()).then(resolve).catch(reject);
    });
  });
}

function init() {
  return exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slave_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'online',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS registers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      address INTEGER NOT NULL,
      name TEXT NOT NULL,
      data_type TEXT NOT NULL,
      rw TEXT NOT NULL,
      unit TEXT,
      description TEXT,
      UNIQUE(device_id, address)
    );

    CREATE TABLE IF NOT EXISTS register_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      reg_address INTEGER NOT NULL,
      value REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_reg_hist_dev_ts ON register_history(device_id, reg_address, timestamp);

    CREATE TABLE IF NOT EXISTS polling_config (
      device_id TEXT PRIMARY KEY,
      interval_ms INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS alarm_rules (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      reg_address INTEGER NOT NULL,
      alarm_type TEXT NOT NULL,
      threshold REAL NOT NULL,
      hysteresis REAL NOT NULL DEFAULT 0,
      delay_seconds INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS alarms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      reg_address INTEGER NOT NULL,
      alarm_type TEXT NOT NULL,
      threshold REAL NOT NULL,
      current_value REAL NOT NULL,
      triggered_at INTEGER NOT NULL,
      recovered_at INTEGER,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      acknowledged_at INTEGER,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_alarms_active ON alarms(active);
    CREATE INDEX IF NOT EXISTS idx_alarms_device ON alarms(device_id, triggered_at);

    CREATE TABLE IF NOT EXISTS computed_tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      expression TEXT NOT NULL,
      source_registers TEXT NOT NULL,
      interval_ms INTEGER NOT NULL,
      current_value REAL
    );

    CREATE TABLE IF NOT EXISTS computed_tag_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag_id TEXT NOT NULL,
      value REAL NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cth_tag_ts ON computed_tag_history(tag_id, timestamp);
  `);
}

module.exports = {
  db,
  run,
  get,
  all,
  exec,
  serialize,
  init
};
