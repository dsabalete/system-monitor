const express = require("express");
const os = require("os");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const https = require("https");
const http = require("http");

const execAsync = promisify(exec);
const app = express();
const PORT = 3000;

// Cache for network stats tracking
let networkStatsCache = {};
let networkStatsTimestamp = null;

app.use(express.static("public"));

// Helper function to format uptime
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

// Helper function to parse throttling status
function parseThrottlingStatus(throttledHex) {
  const flags = parseInt(throttledHex, 16);
  const status = {
    underVoltage: !!(flags & 0x1),
    frequencyCapped: !!(flags & 0x2),
    throttled: !!(flags & 0x4),
    softTempLimit: !!(flags & 0x8),
    underVoltageOccurred: !!(flags & 0x10000),
    frequencyCappedOccurred: !!(flags & 0x20000),
    throttledOccurred: !!(flags & 0x40000),
    softTempLimitOccurred: !!(flags & 0x80000),
  };
  
  const activeIssues = [];
  if (status.underVoltage) activeIssues.push("Undervoltage");
  if (status.frequencyCapped) activeIssues.push("Frequency Capped");
  if (status.throttled) activeIssues.push("Throttled");
  if (status.softTempLimit) activeIssues.push("Soft Temp Limit");
  
  return {
    status: activeIssues.length > 0 ? activeIssues.join(", ") : "Normal",
    flags: status,
  };
}

// Helper function to get network stats from /proc/net/dev
async function getNetworkStats() {
  try {
    const data = await fs.readFile("/proc/net/dev", "utf8");
    const lines = data.split("\n").slice(2); // Skip header lines
    const stats = {};
    
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      
      const interface = parts[0].replace(":", "");
      stats[interface] = {
        rxBytes: parseInt(parts[1], 10),
        txBytes: parseInt(parts[9], 10),
      };
    }
    
    return stats;
  } catch (error) {
    return {};
  }
}

// Helper function to calculate network bandwidth
function calculateNetworkBandwidth(currentStats, previousStats, timeDelta) {
  const bandwidth = {};
  
  for (const [interface, current] of Object.entries(currentStats)) {
    if (!previousStats[interface]) {
      bandwidth[interface] = { rx: 0, tx: 0 };
      continue;
    }
    
    const rxDelta = current.rxBytes - previousStats[interface].rxBytes;
    const txDelta = current.txBytes - previousStats[interface].txBytes;
    
    // Convert bytes to bits per second
    const rxBps = (rxDelta / timeDelta) * 8;
    const txBps = (txDelta / timeDelta) * 8;
    
    bandwidth[interface] = {
      rx: formatBandwidth(rxBps),
      tx: formatBandwidth(txBps),
    };
  }
  
  return bandwidth;
}

// Helper function to format bandwidth
function formatBandwidth(bps) {
  if (bps >= 1000000000) {
    return `${(bps / 1000000000).toFixed(2)} Gbps`;
  } else if (bps >= 1000000) {
    return `${(bps / 1000000).toFixed(2)} Mbps`;
  } else if (bps >= 1000) {
    return `${(bps / 1000).toFixed(2)} Kbps`;
  }
  return `${bps.toFixed(2)} bps`;
}

// Helper function to get public IP
function getPublicIP() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.ipify.org",
      path: "/?format=json",
      method: "GET",
      timeout: 5000,
    };
    
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json.ip);
        } catch (e) {
          resolve(null);
        }
      });
    });
    
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    
    req.end();
  });
}

// Helper function to get local IP addresses
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = { ipv4: [], ipv6: [] };
  
  for (const [name, addrs] of Object.entries(interfaces)) {
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

app.get("/api/stats", async (req, res) => {
  try {
    // CPU Load Average (1, 5, 15 minutes)
    const loadAvg = os.loadavg();
    
    // Uptime
    const uptime = os.uptime();
    
    // RAM
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    // Network stats
    const currentNetworkStats = await getNetworkStats();
    const now = Date.now();
    let networkBandwidth = {};
    
    if (networkStatsTimestamp && networkStatsCache) {
      const timeDelta = (now - networkStatsTimestamp) / 1000; // seconds
      if (timeDelta > 0) {
        networkBandwidth = calculateNetworkBandwidth(
          currentNetworkStats,
          networkStatsCache,
          timeDelta
        );
      }
    }
    
    // Update cache
    networkStatsCache = currentNetworkStats;
    networkStatsTimestamp = now;
    
    // Local IP addresses
    const localIPs = getLocalIPs();
    
    // Public IP (async, don't wait too long)
    const publicIPPromise = getPublicIP();
    
    // Execute system commands in parallel
    const [diskTempResult, throttlingResult, gpuTempResult, cpuTempResult] = await Promise.all([
      execAsync("df -h / | tail -1"),
      execAsync("vcgencmd get_throttled").catch(() => ({ stdout: "throttled=0x0" })),
      execAsync("vcgencmd measure_temp").catch(() => ({ stdout: "temp=0.0'C" })),
      fs.readFile("/sys/class/thermal/thermal_zone0/temp", "utf8").catch(() => Promise.resolve("0")),
    ]);
    
    const diskInfo = diskTempResult.stdout.trim().split(/\s+/);
    const throttledHex = throttlingResult.stdout.trim().replace("throttled=", "");
    const gpuTempRaw = gpuTempResult.stdout.trim();
    const cpuTempMillidegrees = parseInt(String(cpuTempResult).trim(), 10) || 0;
    const cpuTempCelsius = (cpuTempMillidegrees / 1000).toFixed(1);
    
    // Get public IP (with timeout)
    const publicIP = await Promise.race([
      publicIPPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    
    res.json({
      cpu: {
        load1min: loadAvg[0].toFixed(2),
        load5min: loadAvg[1].toFixed(2),
        load15min: loadAvg[2].toFixed(2),
      },
      uptime: {
        seconds: uptime,
        formatted: formatUptime(uptime),
      },
      memory: {
        total: (totalMem / 1024 / 1024).toFixed(0),
        used: (usedMem / 1024 / 1024).toFixed(0),
      },
      disk: {
        used: diskInfo[4],
        size: diskInfo[1],
      },
      temperature: {
        cpu: `${cpuTempCelsius}°C`,
        gpu: gpuTempRaw.replace("temp=", "").replace("'C", "°C"),
      },
      network: {
        bandwidth: networkBandwidth,
      },
      ipAddresses: {
        public: publicIP || "Unable to fetch",
        local: localIPs,
      },
      throttling: parseThrottlingStatus(throttledHex),
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Error leyendo sistema", details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Monitor activo en http://localhost:${PORT}`);
});
