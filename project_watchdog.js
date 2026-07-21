const fs = require('fs');
const path = require('path');
const http = require('http');

const UPLOAD_PATH = process.env.UPLOAD_PATH || "/var/www/storage/uploads";
const DB_PATH = path.join(UPLOAD_PATH, "db.json");
const DEPLOYMENTS_DIR = path.join(UPLOAD_PATH, "deployments");

let intervalId = null;

function readDb() {
  if (!fs.existsSync(DB_PATH)) return { deployments: {} };
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    return { deployments: {} };
  }
}

function writeDb(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch(e) {}
}

function appendDeploymentLog(projectId, message, type = "info") {
  const logsPath = path.join(DEPLOYMENTS_DIR, projectId, "logs.json");
  let logs = [];
  try {
    if (fs.existsSync(logsPath)) logs = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
  } catch(e) {}
  
  logs.push({
    timestamp: new Date().toISOString(),
    message,
    type // info, warn, error, success
  });
  
  if (logs.length > 500) logs = logs.slice(-500);
  
  try {
    fs.writeFileSync(logsPath, JSON.stringify(logs, null, 2));
  } catch(e) {}
}

function recordUptime(projectId, isUp, latency) {
  const uptimePath = path.join(DEPLOYMENTS_DIR, projectId, "uptime.json");
  let uptimeData = [];
  try {
    if (fs.existsSync(uptimePath)) {
      uptimeData = JSON.parse(fs.readFileSync(uptimePath, 'utf8'));
    }
  } catch(e) {}

  uptimeData.push({
    timestamp: new Date().toISOString(),
    isUp,
    latency
  });

  // Keep last 1440 checks (24 hours at 1 minute intervals)
  if (uptimeData.length > 1440) {
    uptimeData = uptimeData.slice(-1440);
  }

  try {
    fs.writeFileSync(uptimePath, JSON.stringify(uptimeData));
  } catch(e) {}
}

async function pingProject(project) {
  return new Promise((resolve) => {
    if (!project.port) {
      resolve({ up: false, latency: 0 });
      return;
    }

    const startTime = Date.now();
    const req = http.get(`http://localhost:${project.port}`, (res) => {
      // Consume response to free memory
      res.on('data', () => {});
      res.on('end', () => {
        const latency = Date.now() - startTime;
        resolve({ up: true, latency });
      });
    });

    req.on('error', (err) => {
      resolve({ up: false, latency: 0 });
    });

    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ up: false, latency: 0 });
    });
  });
}

async function runWatchdogCycle() {
  const db = readDb();
  if (!db.deployments) return;

  let dbUpdated = false;

  for (const [projectId, project] of Object.entries(db.deployments)) {
    if (project.status === 'running') {
      const result = await pingProject(project);
      
      const wasOnline = project.isOnline !== false; // Default to true if not set
      
      recordUptime(projectId, result.up, result.latency);

      if (result.up) {
        if (!wasOnline) {
          project.isOnline = true;
          dbUpdated = true;
          appendDeploymentLog(projectId, `Project is back online.`, "success");
        } else if (project.isOnline === undefined) {
          project.isOnline = true;
          dbUpdated = true;
        }
      } else {
        if (wasOnline) {
          project.isOnline = false;
          dbUpdated = true;
          appendDeploymentLog(projectId, `Project went offline! Uptime ping failed.`, "error");
          
          // TODO: Trigger email/discord alert here if configured
        }
      }
    }
  }

  if (dbUpdated) {
    writeDb(db);
  }
}

function startProjectWatchdog() {
  if (intervalId) clearInterval(intervalId);
  // Run every 60 seconds
  intervalId = setInterval(runWatchdogCycle, 60000);
  console.log("[Project Watchdog] Started monitoring deployed projects (60s interval).");
  
  // Run first cycle immediately
  runWatchdogCycle();
}

function stopProjectWatchdog() {
  if (intervalId) clearInterval(intervalId);
  console.log("[Project Watchdog] Stopped.");
}

module.exports = {
  startProjectWatchdog,
  stopProjectWatchdog
};
