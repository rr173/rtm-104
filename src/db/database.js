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

    CREATE TABLE IF NOT EXISTS maintenance_orders (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      maintenance_type TEXT NOT NULL,
      status TEXT NOT NULL,
      planned_start_at INTEGER,
      planned_end_at INTEGER,
      actual_start_at INTEGER,
      actual_end_at INTEGER,
      description TEXT,
      responsible_person TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_maint_device ON maintenance_orders(device_id);
    CREATE INDEX IF NOT EXISTS idx_maint_status ON maintenance_orders(status);
    CREATE INDEX IF NOT EXISTS idx_maint_planned_start ON maintenance_orders(planned_start_at);

    CREATE TABLE IF NOT EXISTS maintenance_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_maint_events_ts ON maintenance_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_maint_events_order ON maintenance_events(order_id);

    CREATE TABLE IF NOT EXISTS redundancy_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      logical_device_id TEXT NOT NULL,
      primary_device_id TEXT NOT NULL,
      backup_device_id TEXT NOT NULL,
      current_primary_id TEXT,
      status TEXT NOT NULL DEFAULT 'normal',
      failover_count INTEGER NOT NULL DEFAULT 0,
      auto_failback_enabled INTEGER NOT NULL DEFAULT 1,
      failback_delay_seconds INTEGER NOT NULL DEFAULT 300,
      recovered_at INTEGER,
      sync_registers TEXT,
      description TEXT,
      created_at INTEGER NOT NULL,
      last_switch_at INTEGER,
      last_switch_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rd_group_logical ON redundancy_groups(logical_device_id);

    CREATE TABLE IF NOT EXISTS redundancy_device_bindings (
      device_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rd_binding_group ON redundancy_device_bindings(group_id);

    CREATE TABLE IF NOT EXISTS redundancy_switch_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      from_device_id TEXT,
      from_device_name TEXT,
      to_device_id TEXT NOT NULL,
      to_device_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      reason_detail TEXT,
      triggered_by TEXT NOT NULL DEFAULT 'system',
      operator_remark TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      error_message TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_rd_switch_group ON redundancy_switch_history(group_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_rd_switch_ts ON redundancy_switch_history(started_at);

    CREATE TABLE IF NOT EXISTS redundancy_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      source_device_id TEXT NOT NULL,
      target_device_id TEXT NOT NULL,
      reg_address INTEGER NOT NULL,
      old_value REAL,
      new_value REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      error_message TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rd_sync_group ON redundancy_sync_log(group_id, timestamp);

    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      batch_no TEXT NOT NULL UNIQUE,
      product_name TEXT NOT NULL,
      device_ids TEXT NOT NULL,
      locked_registers TEXT NOT NULL,
      planned_quantity INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);
    CREATE INDEX IF NOT EXISTS idx_batches_no ON batches(batch_no);

    CREATE TABLE IF NOT EXISTS batch_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      data TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_batch_snap_batch_ts ON batch_snapshots(batch_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_batch_snap_dev_ts ON batch_snapshots(batch_id, device_id, timestamp);

    CREATE TABLE IF NOT EXISTS batch_param_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      address INTEGER NOT NULL,
      old_value REAL NOT NULL,
      new_value REAL NOT NULL,
      reason TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bpc_batch ON batch_param_changes(batch_id, timestamp);

    CREATE TABLE IF NOT EXISTS batch_reports (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL UNIQUE,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      duration_seconds REAL NOT NULL,
      param_stats TEXT NOT NULL,
      param_changes_count INTEGER NOT NULL DEFAULT 0,
      param_changes_detail TEXT NOT NULL,
      alarm_count INTEGER NOT NULL DEFAULT 0,
      alarm_summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_batch_report_batch ON batch_reports(batch_id);
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
