const { execFile } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");
let BetterSqlite3 = null;
try {
  BetterSqlite3 = require("better-sqlite3");
} catch (e) {
  BetterSqlite3 = null;
}

const execFileAsync = promisify(execFile);
let dbPathGlobal = null;
let db = null;

function initDatabase(dbPath = path.join(process.cwd(), "metrics.db")) {
  if (dbPathGlobal) return dbPathGlobal;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  dbPathGlobal = dbPath;
  const createSql = `
    CREATE TABLE IF NOT EXISTS metrics (
      ts_ms INTEGER NOT NULL,
      cpu_load1 REAL,
      cpu_load5 REAL,
      cpu_load15 REAL,
      mem_used_mb INTEGER,
      mem_total_mb INTEGER,
      disk_used_percent REAL,
      disk_size_bytes INTEGER,
      net_rx_bps REAL,
      net_tx_bps REAL,
      tx_download_bps REAL,
      tx_upload_bps REAL,
      tx_active_torrents INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts_ms);
  `;
  if (BetterSqlite3) {
    db = new BetterSqlite3(dbPathGlobal);
    db.exec(createSql);
    return dbPathGlobal;
  }
  return execFileAsync("sqlite3", [dbPathGlobal, createSql]).then(() => dbPathGlobal).catch(() => dbPathGlobal);
}

function execSql(sql) {
  if (!dbPathGlobal) initDatabase();
  if (db) {
    try {
      const stmt = db.prepare(sql);
      const isSelect = /^\s*select\b/i.test(sql);
      if (isSelect) {
        const rows = stmt.all();
        if (!rows || rows.length === 0) return "";
        const header = Object.keys(rows[0]);
        const out = [header.join(",")].concat(rows.map((r) => header.map((k) => String(r[k])).join(","))).join("\n");
        return out;
      } else {
        stmt.run();
        return "";
      }
    } catch (e) {
      return "";
    }
  }
  return execFileAsync("sqlite3", ["-csv", "-header", dbPathGlobal, sql]).then((res) => res.stdout || "");
}

function insertMetric(sample) {
  const vals = {
    ts_ms: Number(sample.ts_ms) || Date.now(),
    cpu_load1: Number(sample.cpu_load1) || 0,
    cpu_load5: Number(sample.cpu_load5) || 0,
    cpu_load15: Number(sample.cpu_load15) || 0,
    mem_used_mb: Number(sample.mem_used_mb) || 0,
    mem_total_mb: Number(sample.mem_total_mb) || 0,
    disk_used_percent: Number(sample.disk_used_percent) || 0,
    disk_size_bytes: Number(sample.disk_size_bytes) || 0,
    net_rx_bps: Number(sample.net_rx_bps) || 0,
    net_tx_bps: Number(sample.net_tx_bps) || 0,
    tx_download_bps: Number(sample.tx_download_bps) || 0,
    tx_upload_bps: Number(sample.tx_upload_bps) || 0,
    tx_active_torrents: Number(sample.tx_active_torrents) || 0,
  };
  if (db) {
    const stmt = db.prepare(`
      INSERT INTO metrics (
        ts_ms, cpu_load1, cpu_load5, cpu_load15,
        mem_used_mb, mem_total_mb,
        disk_used_percent, disk_size_bytes,
        net_rx_bps, net_tx_bps,
        tx_download_bps, tx_upload_bps, tx_active_torrents
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      stmt.run(
        vals.ts_ms,
        vals.cpu_load1,
        vals.cpu_load5,
        vals.cpu_load15,
        vals.mem_used_mb,
        vals.mem_total_mb,
        vals.disk_used_percent,
        vals.disk_size_bytes,
        vals.net_rx_bps,
        vals.net_tx_bps,
        vals.tx_download_bps,
        vals.tx_upload_bps,
        vals.tx_active_torrents
      );
    } catch (e) {
    }
    return "";
  }
  const sql = `
    INSERT INTO metrics (
      ts_ms, cpu_load1, cpu_load5, cpu_load15,
      mem_used_mb, mem_total_mb,
      disk_used_percent, disk_size_bytes,
      net_rx_bps, net_tx_bps,
      tx_download_bps, tx_upload_bps, tx_active_torrents
    ) VALUES (
      ${vals.ts_ms}, ${vals.cpu_load1}, ${vals.cpu_load5}, ${vals.cpu_load15},
      ${vals.mem_used_mb}, ${vals.mem_total_mb},
      ${vals.disk_used_percent}, ${vals.disk_size_bytes},
      ${vals.net_rx_bps}, ${vals.net_tx_bps},
      ${vals.tx_download_bps}, ${vals.tx_upload_bps}, ${vals.tx_active_torrents}
    );
  `;
  return execSql(sql).catch(() => "");
}

function getHistory({ limit = 360, fromMs = null } = {}) {
  if (db) {
    if (Number.isFinite(fromMs) && fromMs > 0) {
      const stmt = db.prepare(`
        SELECT * FROM metrics
        WHERE ts_ms >= ?
        ORDER BY ts_ms ASC
      `);
      return Promise.resolve(stmt.all(fromMs));
    }
    const stmt = db.prepare(`
      SELECT * FROM metrics
      ORDER BY ts_ms DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit);
    rows.reverse();
    return Promise.resolve(rows);
  }
  if (Number.isFinite(fromMs) && fromMs > 0) {
    const sql = `
      SELECT * FROM metrics
      WHERE ts_ms >= ${fromMs}
      ORDER BY ts_ms ASC;
    `;
    return execSql(sql).then(parseCsvRows);
  }
  const sql = `
    SELECT * FROM metrics
    ORDER BY ts_ms DESC
    LIMIT ${limit};
  `;
  return execSql(sql).then((out) => {
    const rows = parseCsvRows(out);
    return rows.reverse();
  });
}

function parseCsvRows(output) {
  const text = String(output || "").trim();
  if (!text) return [];
  const lines = text.split("\n");
  const header = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const obj = {};
    for (let j = 0; j < header.length; j++) {
      const key = header[j];
      const val = cols[j];
      const num = Number(val);
      obj[key] = Number.isFinite(num) ? num : val;
    }
    rows.push(obj);
  }
  return rows;
}

module.exports = {
  initDatabase,
  insertMetric,
  getHistory,
};
