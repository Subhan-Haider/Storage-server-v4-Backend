const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const os = require("os");
const osUtils = require("os-utils");
const https = require("https");

const UPLOAD_PATH = process.env.UPLOAD_PATH || "/var/www/storage/uploads";
const WATCHDOG_LOG_PATH = path.join(UPLOAD_PATH, "watchdog_log.jsonl");
const WATCHDOG_STATE_PATH = path.join(UPLOAD_PATH, "watchdog_state.json");

// Default configuration
const DEFAULT_CONFIG = {
  enabled: true,
  pingTargets: ["1.1.1.1", "8.8.8.8"],
  checkIntervalMs: 30000,
  services: ["docker", "nginx"],
  maxRecoveryAttempts: 3,
  rebootOnMaxFailures: false,
  maxRebootsPerHour: 1,
  notificationWebhooks: {
    telegram: "",
    discord: process.env.DISCORD_WEBHOOK_URL || "",
    slack: ""
  }
};

let watchdogInterval = null;
let isChecking = false;

function readWatchdogState() {
  if (!fs.existsSync(WATCHDOG_STATE_PATH)) {
    return {
      config: DEFAULT_CONFIG,
      liveStatus: "Healthy",
      lastCheck: null,
      recoveryAttemptsToday: 0,
      totalReboots: 0,
      services: {},
      network: { internet: true, gateway: true, dns: true },
      stats: { cpu: 0, ram: 0, disk: 0 }
    };
  }
  try {
    const data = JSON.parse(fs.readFileSync(WATCHDOG_STATE_PATH, "utf8"));
    if (!data.config) data.config = DEFAULT_CONFIG;
    return data;
  } catch (e) {
    console.error("Error reading watchdog state:", e);
    return { config: DEFAULT_CONFIG, liveStatus: "Healthy", services: {}, network: {} };
  }
}

function writeWatchdogState(state) {
  try {
    fs.writeFileSync(WATCHDOG_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Error writing watchdog state:", e);
  }
}

function appendLog(severity, category, action, message) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    severity,
    category,
    action,
    message,
  };
  try {
    fs.appendFileSync(WATCHDOG_LOG_PATH, JSON.stringify(logEntry) + "\n");
  } catch (e) {
    console.error("Error writing watchdog log:", e);
  }

  // Trigger Discord notifications for critical and warning events
  if (severity === "critical" || severity === "warning") {
    const state = readWatchdogState();
    const webhookUrl = state.config?.notificationWebhooks?.discord;
    if (webhookUrl) {
      const color = severity === "critical" ? 16711680 : 16753920;
      const payload = JSON.stringify({
        embeds: [{
          title: `Server Watchdog Alert`,
          description: `**[${severity.toUpperCase()}]** - ${message}`,
          color: color,
          timestamp: new Date().toISOString()
        }]
      });
      
      try {
        const url = new URL(webhookUrl);
        const req = https.request({
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          }
        }, (res) => {});
        req.on("error", () => {});
        req.write(payload);
        req.end();
      } catch (err) {
        console.error("Failed to parse or send webhook", err);
      }
    }
  }
}

function execCommand(command) {
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, output: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout.trim() });
      }
    });
  });
}

async function checkInternet(targets) {
  for (const target of targets) {
    const isWindows = os.platform() === 'win32';
    const pingCmd = isWindows ? `ping -n 1 -w 2000 ${target}` : `ping -c 1 -W 2 ${target}`;
    const res = await execCommand(pingCmd);
    if (res.success) return true;
  }
  return false;
}

async function checkServiceStatus(service) {
  const isWindows = os.platform() === 'win32';
  if (isWindows) return true; // Mock for Windows
  const res = await execCommand(`systemctl is-active ${service}`);
  return res.output === 'active';
}

async function restartService(service) {
  const isWindows = os.platform() === 'win32';
  if (isWindows) return false;
  const res = await execCommand(`sudo systemctl restart ${service}`);
  return res.success;
}

async function performNetworkRecovery(state) {
  appendLog("critical", "network", "recovery_started", "Internet offline. Attempting network recovery.");
  const isWindows = os.platform() === 'win32';
  
  if (isWindows) {
    appendLog("info", "network", "recovery_skipped", "Skipped recovery on Windows dev env");
    return;
  }

  await execCommand("sudo resolvectl flush-caches");
  appendLog("warning", "network", "flush_dns", "Flushed DNS cache");
  
  await new Promise(r => setTimeout(r, 2000));
  const stillOffline = !(await checkInternet(state.config.pingTargets));
  
  if (stillOffline) {
    await execCommand("sudo systemctl restart systemd-networkd || sudo systemctl restart NetworkManager");
    appendLog("critical", "network", "restart_network", "Restarted networking services");
  }
}

async function getStats() {
  return new Promise((resolve) => {
    osUtils.cpuUsage((cpuPercent) => {
      const ramTotal = os.totalmem();
      const ramFree = os.freemem();
      const ramUsed = ramTotal - ramFree;
      const ramPercent = (ramUsed / ramTotal) * 100;
      resolve({
        cpu: cpuPercent * 100,
        ram: ramPercent,
        uptime: os.uptime(),
      });
    });
  });
}

async function runWatchdogCycle() {
  if (isChecking) return;
  isChecking = true;
  
  const state = readWatchdogState();
  if (!state.config.enabled) {
    isChecking = false;
    return;
  }

  state.lastCheck = new Date().toISOString();
  let systemHealthy = true;
  
  // Reset daily attempts if a new day
  const todayDate = new Date().toISOString().split("T")[0];
  if (state.lastRecoveryDate !== todayDate) {
    state.recoveryAttemptsToday = 0;
    state.lastRecoveryDate = todayDate;
  }

  try {
    const internetOk = await checkInternet(state.config.pingTargets || []);
    state.network.internet = internetOk;
    
    if (!internetOk) {
      systemHealthy = false;
      state.liveStatus = "Critical";
      
      if (state.recoveryAttemptsToday < (state.config.maxRecoveryAttempts || 3)) {
        state.recoveryAttemptsToday += 1;
        await performNetworkRecovery(state);
        
        const reCheck = await checkInternet(state.config.pingTargets || []);
        if (reCheck) {
          state.liveStatus = "Healthy";
          appendLog("info", "network", "recovery_success", "Internet restored after recovery actions.");
        } else if (state.config.rebootOnMaxFailures) {
          appendLog("critical", "system", "auto_reboot", "Internet completely offline. Auto-reboot triggered.");
          if (os.platform() !== 'win32') execCommand("sudo reboot");
        }
      } else {
        appendLog("critical", "network", "max_recovery_reached", "Internet offline. Max recovery attempts reached.");
      }
    }

    const services = state.config.services || [];
    for (const service of services) {
      const isActive = await checkServiceStatus(service);
      state.services[service] = isActive;
      
      if (!isActive) {
        systemHealthy = false;
        
        if (state.recoveryAttemptsToday < (state.config.maxRecoveryAttempts || 3)) {
          state.recoveryAttemptsToday += 1;
          appendLog("warning", "service", "service_stopped", `Service ${service} is down. Attempting restart...`);
          const restarted = await restartService(service);
          if (restarted) {
            appendLog("info", "service", "recovery_success", `Service ${service} restarted successfully.`);
            state.services[service] = true;
          } else {
            appendLog("critical", "service", "recovery_failed", `Failed to restart service ${service}.`);
          }
        } else {
          appendLog("critical", "service", "max_recovery_reached", `Service ${service} is down. Max recovery attempts reached.`);
        }
      }
    }

    // Monitor PM2 deployments
    try {
      const deploymentEngine = require("./deployment_engine");
      const projects = deploymentEngine.readProjects();
      const res = await execCommand("pm2 jlist");
      let pm2List = [];
      if (res.success) {
        try { pm2List = JSON.parse(res.output); } catch(e) {}
      }

      // ─── SELF-HEAL: Restart the main backend if it has crashed ───────────────
      const BACKEND_PM2_NAME = "cloud-backend";
      const backendProc = pm2List.find(p => p.name === BACKEND_PM2_NAME);
      const backendOnline = backendProc && backendProc.pm2_env && backendProc.pm2_env.status === "online";
      if (!backendOnline) {
        systemHealthy = false;
        appendLog("critical", "backend", "backend_crashed", `Main backend process "${BACKEND_PM2_NAME}" is down! Attempting auto-restart via PM2...`);
        const restartRes = await execCommand(`pm2 restart ${BACKEND_PM2_NAME}`);
        if (restartRes.success) {
          appendLog("info", "backend", "backend_recovered", `Main backend "${BACKEND_PM2_NAME}" was successfully restarted by watchdog.`);
        } else {
          appendLog("critical", "backend", "backend_recovery_failed", `Failed to restart "${BACKEND_PM2_NAME}": ${restartRes.output}`);
        }
      }
      // ─────────────────────────────────────────────────────────────────────────

      for (const project of projects) {
        if (project.status === "running") {
          const pm2Process = pm2List.find(p => p.name === project.id);
          const isOnline = pm2Process && pm2Process.pm2_env && pm2Process.pm2_env.status === "online";
          if (!isOnline) {
            systemHealthy = false;
            if (state.recoveryAttemptsToday < (state.config.maxRecoveryAttempts || 3)) {
              state.recoveryAttemptsToday += 1;
              appendLog("warning", "deployment", "deployment_crashed", `Deployment ${project.name} is down. Attempting restart...`);
              await execCommand(`pm2 restart ${project.id}`);
            } else {
              appendLog("critical", "deployment", "max_recovery_reached", `Deployment ${project.name} is down. Max recovery attempts reached.`);
            }
          }
        }
      }
    } catch (e) {
      console.error("Error monitoring PM2 deployments:", e);
    }

    const stats = await getStats();
    state.stats = { ...state.stats, ...stats };

    if (systemHealthy && state.liveStatus !== "Healthy") {
      state.liveStatus = "Healthy";
    } else if (!systemHealthy && state.liveStatus === "Healthy") {
      state.liveStatus = "Warning";
    }

  } catch (e) {
    console.error("Watchdog cycle error:", e);
  } finally {
    writeWatchdogState(state);
    isChecking = false;
  }
}

function startWatchdog() {
  const state = readWatchdogState();
  if (watchdogInterval) clearInterval(watchdogInterval);
  
  runWatchdogCycle();
  watchdogInterval = setInterval(runWatchdogCycle, state.config.checkIntervalMs || 30000);
  console.log(`[Watchdog] Started with interval ${state.config.checkIntervalMs || 30000}ms`);
}

function stopWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = null;
  console.log(`[Watchdog] Stopped.`);
}

function getWatchdogState() {
  return readWatchdogState();
}

function getWatchdogLogs(limit = 100) {
  if (!fs.existsSync(WATCHDOG_LOG_PATH)) return [];
  try {
    const lines = fs.readFileSync(WATCHDOG_LOG_PATH, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).map(l => JSON.parse(l)).reverse();
  } catch (e) {
    return [];
  }
}

module.exports = {
  startWatchdog,
  stopWatchdog,
  getWatchdogState,
  getWatchdogLogs,
  writeWatchdogState,
  appendLog
};
