const os = require("os");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const https = require("https");

const { formatBandwidth, formatUptime, parseThrottlingStatus } = require("./format");
const { COMMAND_TIMEOUT_MS, PUBLIC_IP_TIMEOUT_MS } = require("../config");

const execAsync = promisify(exec);

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
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
    const data = await fs.readFile("/proc/net/dev", "utf8");
    const lines = data.split("\n").slice(2);
    const stats = {};

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;

      const iface = parts[0].replace(":", "");
      stats[iface] = {
        rxBytes: Number.parseInt(parts[1], 10) || 0,
        txBytes: Number.parseInt(parts[9], 10) || 0,
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
  const stdout = await runCommand("df -h / | tail -1");
  if (!stdout) return { used: "N/A", size: "N/A" };

  const parts = stdout.trim().split(/\s+/);
  const size = parts[1] || "N/A";
  const used = parts[4] || "N/A";
  return { used, size };
}

async function getGpuTemp() {
  const stdout = await runCommand("vcgencmd measure_temp");
  if (!stdout) return "0.0°C";
  return stdout.replace("temp=", "").replace("'C", "°C");
}

async function getThrottlingHex() {
  const stdout = await runCommand("vcgencmd get_throttled");
  if (!stdout) return "0x0";
  return stdout.trim().replace("throttled=", "");
}

async function getCpuTemp() {
  try {
    const raw = await fs.readFile("/sys/class/thermal/thermal_zone0/temp", "utf8");
    const millidegrees = Number.parseInt(String(raw).trim(), 10) || 0;
    return `${(millidegrees / 1000).toFixed(1)}°C`;
  } catch (_error) {
    return "0.0°C";
  }
}

function createStatsCollector({ now = () => Date.now() } = {}) {
  let previousNetworkStats = null;
  let previousNetworkTimestampMs = null;

  async function getStats() {
    const loadAvg = os.loadavg();
    const uptimeSeconds = os.uptime();

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const currentNetworkStats = await getNetworkStats();
    const currentTimestampMs = now();

    const timeDeltaSeconds =
      previousNetworkTimestampMs == null ? 0 : (currentTimestampMs - previousNetworkTimestampMs) / 1000;

    const networkBandwidth = calculateNetworkBandwidth(
      currentNetworkStats,
      previousNetworkStats,
      timeDeltaSeconds
    );

    previousNetworkStats = currentNetworkStats;
    previousNetworkTimestampMs = currentTimestampMs;

    const localIPs = getLocalIPs();

    const [disk, throttlingHex, gpuTemp, cpuTemp, publicIP] = await Promise.all([
      getDiskUsage(),
      getThrottlingHex(),
      getGpuTemp(),
      getCpuTemp(),
      withTimeout(getPublicIP(), PUBLIC_IP_TIMEOUT_MS),
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
      },
      ipAddresses: {
        public: publicIP || "Unable to fetch",
        local: localIPs,
      },
      throttling: parseThrottlingStatus(throttlingHex),
    };
  }

  return { getStats };
}

module.exports = {
  createStatsCollector,
};
