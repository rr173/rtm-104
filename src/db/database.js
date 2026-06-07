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

async function migrate() {
  const alarmColumns = await all("PRAGMA table_info(alarm_rules)");
  const alarmColNames = alarmColumns.map(c => c.name);
  if (!alarmColNames.includes('notify_channel')) {
    await run("ALTER TABLE alarm_rules ADD COLUMN notify_channel TEXT NOT NULL DEFAULT 'log'");
  }
  if (!alarmColNames.includes('escalate_after_seconds')) {
    await run("ALTER TABLE alarm_rules ADD COLUMN escalate_after_seconds INTEGER NOT NULL DEFAULT 0");
  }
  if (!alarmColNames.includes('webhook_url')) {
    await run("ALTER TABLE alarm_rules ADD COLUMN webhook_url TEXT");
  }

  const deviceColumns = await all("PRAGMA table_info(devices)");
  const deviceColNames = deviceColumns.map(c => c.name);
  if (!deviceColNames.includes('firmware_version')) {
    await run("ALTER TABLE devices ADD COLUMN firmware_version TEXT NOT NULL DEFAULT '1.0.0'");
  }
}

function init() {
  return serialize(async () => {
    await exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slave_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'online',
      firmware_version TEXT NOT NULL DEFAULT '1.0.0',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS firmware (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL UNIQUE,
      description TEXT,
      file_size INTEGER NOT NULL DEFAULT 0,
      checksum TEXT,
      uploaded_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ota_upgrades (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      firmware_id TEXT NOT NULL,
      firmware_version TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_ota_device ON ota_upgrades(device_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_ota_status ON ota_upgrades(status);

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
      delay_seconds INTEGER NOT NULL DEFAULT 0,
      notify_channel TEXT NOT NULL DEFAULT 'log',
      escalate_after_seconds INTEGER NOT NULL DEFAULT 0,
      webhook_url TEXT
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

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alarm_id INTEGER NOT NULL,
      device_name TEXT NOT NULL,
      reg_name TEXT NOT NULL,
      current_value REAL NOT NULL,
      threshold REAL NOT NULL,
      alarm_type TEXT NOT NULL,
      notify_channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      is_escalation INTEGER NOT NULL DEFAULT 0,
      parent_notification_id INTEGER,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
    CREATE INDEX IF NOT EXISTS idx_notifications_alarm ON notifications(alarm_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

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

    CREATE TABLE IF NOT EXISTS interlocks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      condition TEXT NOT NULL,
      actions TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 3,
      enabled INTEGER NOT NULL DEFAULT 1,
      auto_reset INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interlock_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interlock_id TEXT NOT NULL,
      interlock_name TEXT NOT NULL,
      trigger_value REAL NOT NULL,
      actions TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_il_events_ts ON interlock_events(timestamp);

    CREATE TABLE IF NOT EXISTS sequences (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      steps TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recipe_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      address INTEGER NOT NULL,
      value REAL NOT NULL,
      UNIQUE(recipe_id, device_id, address)
    );

    CREATE INDEX IF NOT EXISTS idx_recipe_items_recipe ON recipe_items(recipe_id);

    CREATE TABLE IF NOT EXISTS recipe_executions (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      status TEXT NOT NULL,
      executed_at INTEGER NOT NULL,
      error TEXT,
      rolled_back INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_recipe_exec_ts ON recipe_executions(executed_at);

    CREATE TABLE IF NOT EXISTS recipe_execution_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      address INTEGER NOT NULL,
      target_value REAL NOT NULL,
      original_value REAL NOT NULL,
      final_value REAL NOT NULL,
      write_status TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rei_execution ON recipe_execution_items(execution_id);

    CREATE TABLE IF NOT EXISTS trend_configs (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      reg_address INTEGER NOT NULL,
      window_size INTEGER NOT NULL DEFAULT 50,
      sensitivity REAL NOT NULL DEFAULT 3.0,
      interval_ms INTEGER NOT NULL DEFAULT 2000,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE(device_id, reg_address)
    );

    CREATE INDEX IF NOT EXISTS idx_trend_cfg_dev ON trend_configs(device_id);

    CREATE TABLE IF NOT EXISTS trend_anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      reg_address INTEGER NOT NULL,
      anomaly_value REAL NOT NULL,
      mean REAL NOT NULL,
      stddev REAL NOT NULL,
      deviation_ratio REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trend_anom_dev_ts ON trend_anomalies(device_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_trend_anom_ts ON trend_anomalies(timestamp);

    CREATE TABLE IF NOT EXISTS replay_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_ids TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      speed_multiplier REAL NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      total_records INTEGER NOT NULL,
      triggered_alarms TEXT NOT NULL,
      triggered_interlocks TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_replay_reports_ts ON replay_reports(started_at);

    CREATE TABLE IF NOT EXISTS work_shifts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      start_hour INTEGER NOT NULL,
      start_minute INTEGER NOT NULL,
      end_hour INTEGER NOT NULL,
      end_minute INTEGER NOT NULL,
      cross_day INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS energy_bindings (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      power_reg_address INTEGER NOT NULL,
      rated_power REAL NOT NULL DEFAULT 0,
      load_threshold REAL NOT NULL DEFAULT 0,
      threshold_kwh REAL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE(device_id, power_reg_address)
    );

    CREATE INDEX IF NOT EXISTS idx_energy_binding_dev ON energy_bindings(device_id);

    CREATE TABLE IF NOT EXISTS shift_energy_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      shift_id TEXT NOT NULL,
      shift_date TEXT NOT NULL,
      energy_kwh REAL NOT NULL DEFAULT 0,
      runtime_seconds REAL NOT NULL DEFAULT 0,
      avg_load_rate REAL NOT NULL DEFAULT 0,
      peak_power REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      completed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(device_id, shift_id, shift_date)
    );

    CREATE INDEX IF NOT EXISTS idx_shift_stats_date ON shift_energy_stats(shift_date);
    CREATE INDEX IF NOT EXISTS idx_shift_stats_dev ON shift_energy_stats(device_id, shift_date);

    CREATE TABLE IF NOT EXISTS energy_alarms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      shift_id TEXT NOT NULL,
      shift_date TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      energy_kwh REAL NOT NULL,
      threshold_kwh REAL NOT NULL,
      triggered_at INTEGER NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      acknowledged_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_energy_alarm_shift ON energy_alarms(device_id, shift_id, shift_date);
    CREATE INDEX IF NOT EXISTS idx_energy_alarm_ts ON energy_alarms(triggered_at);
  `);
    await migrate();
  });
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
