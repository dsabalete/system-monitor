const os = require("os");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const https = require("https");
const si = require("systeminformation");
const http = require("http");

const { formatBandwidth, formatBytes, formatUptime, parseThrottlingStatus } = require("./format");
const {
  COMMAND_TIMEOUT_MS,
  PUBLIC_IP_TIMEOUT_MS,
  TRANSMISSION_URL,
  TRANSMISSION_USERNAME,
  TRANSMISSION_PASSWORD,
  TRANSMISSION_TIMEOUT_MS,
} = require("../config");

const execAsync = promisify(exec);
const transmissionSessionIds = new Map();

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function extractTransmissionSessionIdFromText(text) {
  const match = String(text || "").match(/X-Transmission-Session-Id:\s*([^\s<]+)/i);
  return match ? match[1] : null;
}

function getTransmissionEndpoint() {
  const url = new URL(TRANSMISSION_URL);
  const isHttps = url.protocol === "https:";
  const mod = isHttps ? https : http;
  const port = url.port ? Number(url.port) : (isHttps ? 443 : 80);
  const path = url.pathname && url.pathname !== "/" ? url.pathname : "/transmission/rpc";
  const key = `${url.protocol}//${url.hostname}:${port}${path}`;
  return { url, isHttps, mod, port, path, key };
}

async function runCommand(command, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execAsync(command, { timeout: timeoutMs, windowsHide: true });
    return String(stdout || "").trim();
  } catch (_error) {
    return null;
  }
}

async function getNetworkStats() {
  try {
    const list = await si.networkStats();
    const stats = {};
    for (const item of list || []) {
      const iface = String(item.iface || "").trim();
      if (!iface) continue;
      stats[iface] = {
        rxBytes: Number(item.rx_bytes) || 0,
        txBytes: Number(item.tx_bytes) || 0,
      };
    }
    return stats;
  } catch (_error) {
    return {};
  }
}

function calculateNetworkBandwidth(currentStats, previousStats, timeDeltaSeconds) {
  const bandwidth = {};
  if (!previousStats || timeDeltaSeconds <= 0) return bandwidth;

  for (const [iface, current] of Object.entries(currentStats)) {
    const previous = previousStats[iface];
    if (!previous) continue;

    const rxDeltaBytes = current.rxBytes - previous.rxBytes;
    const txDeltaBytes = current.txBytes - previous.txBytes;

    const rxBps = (rxDeltaBytes / timeDeltaSeconds) * 8;
    const txBps = (txDeltaBytes / timeDeltaSeconds) * 8;

    bandwidth[iface] = {
      rx: formatBandwidth(rxBps),
      tx: formatBandwidth(txBps),
    };
  }

  return bandwidth;
}

function formatTotals(currentStats) {
  const perInterface = {};
  let aggRx = 0;
  let aggTx = 0;
  for (const [iface, cur] of Object.entries(currentStats)) {
    const rx = Number(cur.rxBytes) || 0;
    const tx = Number(cur.txBytes) || 0;
    perInterface[iface] = {
      rxTotal: formatBytes(rx),
      txTotal: formatBytes(tx),
    };
    aggRx += rx;
    aggTx += tx;
  }
  return {
    perInterface,
    aggregate: {
      rxTotal: formatBytes(aggRx),
      txTotal: formatBytes(aggTx),
    },
  };
}

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = { ipv4: [], ipv6: [] };

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!Array.isArray(addrs)) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        ips.ipv4.push({ interface: name, address: addr.address });
      } else if (addr.family === "IPv6" && !addr.internal) {
        ips.ipv6.push({ interface: name, address: addr.address });
      }
    }
  }

  return ips;
}

function getPublicIP() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.ipify.org",
        path: "/?format=json",
        method: "GET",
        timeout: 5000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.ip || null);
          } catch (_e) {
            resolve(null);
          }
        });
      }
    );

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

async function getDiskUsage() {
  try {
    const disks = await si.fsSize();
    let target = null;
    for (const d of disks || []) {
      if (d.mount === "/") {
        target = d;
        break;
      }
    }
    if (!target && (disks || []).length > 0) {
      target = disks.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a), disks[0]);
    }
    if (!target) return { used: "N/A", size: "N/A" };
    const sizeBytes = Number(target.size) || 0;
    const usedPercent =
      Number.isFinite(target.use) && target.use > 0
        ? Number(target.use)
        : sizeBytes > 0
          ? ((Number(target.used) || 0) / sizeBytes) * 100
          : 0;
    return { used: `${usedPercent.toFixed(0)}%`, size: formatBytes(sizeBytes) };
  } catch (_error) {
    return { used: "N/A", size: "N/A" };
  }
}

async function getGpuTemp() {
  try {
    const graphics = await si.graphics();
    const controller = (graphics.controllers || []).find((c) => Number.isFinite(c.temperatureGpu));
    const temp = controller ? controller.temperatureGpu : null;
    if (!Number.isFinite(temp)) return "0.0°C";
    return `${Number(temp).toFixed(1)}°C`;
  } catch (_error) {
    const stdout = await runCommand("vcgencmd measure_temp");
    if (!stdout) return "0.0°C";
    return stdout.replace("temp=", "").replace("'C", "°C");
  }
}

async function getThrottlingHex() {
  const stdout = await runCommand("vcgencmd get_throttled");
  if (!stdout) return "0x0";
  return stdout.trim().replace("throttled=", "");
}

async function getCpuTemp() {
  try {
    const t = await si.cpuTemperature();
    const temp =
      Array.isArray(t?.cores) && t.cores.length
        ? t.cores[0]
        : Number.isFinite(t?.main)
          ? t.main
          : null;
    if (!Number.isFinite(temp)) {
      const raw = await fs.readFile("/sys/class/thermal/thermal_zone0/temp", "utf8").catch(() => null);
      if (!raw) return "0.0°C";
      const millidegrees = Number.parseInt(String(raw).trim(), 10) || 0;
      return `${(millidegrees / 1000).toFixed(1)}°C`;
    }
    return `${Number(temp).toFixed(1)}°C`;
  } catch (_error) {
    return "0.0°C";
  }
}

function transmissionHttpRequest(endpoint, body, sessionId) {
  if (!TRANSMISSION_URL) return Promise.resolve(null);
  try {
    const authHeader =
      TRANSMISSION_USERNAME && TRANSMISSION_PASSWORD
        ? "Basic " + Buffer.from(`${TRANSMISSION_USERNAME}:${TRANSMISSION_PASSWORD}`).toString("base64")
        : null;
    const payload = JSON.stringify(body || {});
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (authHeader) headers["Authorization"] = authHeader;
    if (sessionId) headers["X-Transmission-Session-Id"] = sessionId;
    const options = {
      hostname: endpoint.url.hostname,
      port: endpoint.port,
      path: endpoint.path,
      method: "POST",
      timeout: TRANSMISSION_TIMEOUT_MS || 3000,
      headers,
    };
    return new Promise((resolve) => {
      const req = endpoint.mod.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const sessionHeader =
            res.headers["x-transmission-session-id"] || extractTransmissionSessionIdFromText(data);
          try {
            const json = JSON.parse(data || "{}");
            resolve({ statusCode: res.statusCode || 0, data: json, sessionId: sessionHeader || null });
          } catch (_e) {
            resolve({ statusCode: res.statusCode || 0, data: null, sessionId: sessionHeader || null });
          }
        });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.write(payload);
      req.end();
    });
  } catch (_e) {
    return Promise.resolve(null);
  }
}

async function transmissionRpc(body) {
  let endpoint;
  try {
    endpoint = getTransmissionEndpoint();
  } catch (_e) {
    return null;
  }
  const cachedSessionId = transmissionSessionIds.get(endpoint.key) || null;
  const first = await transmissionHttpRequest(endpoint, body, cachedSessionId);
  if (!first) return null;
  if (first.sessionId) transmissionSessionIds.set(endpoint.key, first.sessionId);
  if (first.statusCode === 409) {
    const retrySessionId = first.sessionId || transmissionSessionIds.get(endpoint.key) || null;
    if (!retrySessionId) return first;
    const second = await transmissionHttpRequest(endpoint, body, retrySessionId);
    if (!second) return null;
    if (second.sessionId) transmissionSessionIds.set(endpoint.key, second.sessionId);
    if (second.statusCode === 409 && second.sessionId && second.sessionId !== retrySessionId) {
      const third = await transmissionHttpRequest(endpoint, body, second.sessionId);
      if (third?.sessionId) transmissionSessionIds.set(endpoint.key, third.sessionId);
      return third;
    }
    return second;
  }
  return first;
}

function mapTransmissionStatus(code) {
  switch (code) {
    case 0:
      return "stopped";
    case 1:
      return "check_wait";
    case 2:
      return "checking";
    case 3:
      return "download_wait";
    case 4:
      return "downloading";
    case 5:
      return "seed_wait";
    case 6:
      return "seeding";
    default:
      return "unknown";
  }
}

async function getTransmissionStats() {
  if (!TRANSMISSION_URL) {
    return { enabled: false };
  }
  const txTimeoutMs = Number(TRANSMISSION_TIMEOUT_MS) || 3000;
  const sessionReq = await withTimeout(
    transmissionRpc({ method: "session-stats", arguments: {} }),
    txTimeoutMs * 2
  );
  const torrentsReq = await withTimeout(
    transmissionRpc({
      method: "torrent-get",
      arguments: {
        fields: ["id", "name", "status", "rateDownload", "rateUpload", "percentDone", "errorString"],
      },
    }),
    txTimeoutMs * 2
  );
  if (!sessionReq || !torrentsReq || !sessionReq.data || !torrentsReq.data) {
    return { enabled: true, error: "No disponible" };
  }
  const session = sessionReq.data.arguments || {};
  const torrents = Array.isArray(torrentsReq.data.arguments?.torrents)
    ? torrentsReq.data.arguments.torrents
    : [];
  const active = torrents.filter((t) => t && (t.status === 4 || t.status === 6));
  return {
    enabled: true,
    session: {
      download: formatBandwidth(((session.downloadSpeed || 0) * 8) || 0),
      upload: formatBandwidth(((session.uploadSpeed || 0) * 8) || 0),
      activeTorrents: Number(session.activeTorrentCount || 0),
      pausedTorrents: Number(session.pausedTorrentCount || 0),
    },
    torrents: active.map((t) => ({
      id: t.id,
      name: t.name,
      status: mapTransmissionStatus(t.status),
      download: formatBandwidth(((t.rateDownload || 0) * 8) || 0),
      upload: formatBandwidth(((t.rateUpload || 0) * 8) || 0),
      progress: ((t.percentDone || 0) * 100).toFixed(1) + "%",
      error: t.errorString || "",
    })),
  };
}

function createStatsCollector({ now = () => Date.now() } = {}) {
  let previousNetworkStats = null;
  let previousNetworkTimestampMs = null;

  async function getStats() {
    const loadAvg = os.loadavg();
    const uptimeSeconds = os.uptime();
    let totalMem = os.totalmem();
    let usedMem = totalMem - os.freemem();
    try {
      const mem = await si.mem();
      if (mem && Number.isFinite(mem.total) && Number.isFinite(mem.used)) {
        totalMem = mem.total;
        usedMem = mem.used;
      }
    } catch (_e) { }

    const currentNetworkStats = await getNetworkStats();
    const currentTimestampMs = now();

    const timeDeltaSeconds =
      previousNetworkTimestampMs == null ? 0 : (currentTimestampMs - previousNetworkTimestampMs) / 1000;

    const networkBandwidth = calculateNetworkBandwidth(
      currentNetworkStats,
      previousNetworkStats,
      timeDeltaSeconds
    );
    const networkTotals = formatTotals(currentNetworkStats);

    previousNetworkStats = currentNetworkStats;
    previousNetworkTimestampMs = currentTimestampMs;

    const localIPs = getLocalIPs();

    const [disk, throttlingHex, gpuTemp, cpuTemp, publicIP, transmission] = await Promise.all([
      getDiskUsage(),
      getThrottlingHex(),
      getGpuTemp(),
      getCpuTemp(),
      withTimeout(getPublicIP(), PUBLIC_IP_TIMEOUT_MS),
      getTransmissionStats(),
    ]);

    return {
      cpu: {
        load1min: loadAvg[0].toFixed(2),
        load5min: loadAvg[1].toFixed(2),
        load15min: loadAvg[2].toFixed(2),
      },
      uptime: {
        seconds: uptimeSeconds,
        formatted: formatUptime(uptimeSeconds),
      },
      memory: {
        total: (totalMem / 1024 / 1024).toFixed(0),
        used: (usedMem / 1024 / 1024).toFixed(0),
      },
      disk,
      temperature: {
        cpu: cpuTemp,
        gpu: gpuTemp,
      },
      network: {
        bandwidth: networkBandwidth,
        totals: networkTotals,
      },
      ipAddresses: {
        public: publicIP || "Unable to fetch",
        local: localIPs,
      },
      throttling: parseThrottlingStatus(throttlingHex),
      transmission,
    };
  }

  return { getStats };
}

module.exports = {
  createStatsCollector,
};
