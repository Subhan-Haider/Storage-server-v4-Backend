const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('yaml');
const { exec } = require('child_process');

const isWindows = os.platform() === 'win32';
const DEFAULT_CONFIG_PATH = isWindows
  ? path.join(os.homedir(), '.cloudflared', 'deployments-config.yml')
  : '/home/subhan/.cloudflared/deployments-config.yml';

const CONFIG_PATH = process.env.CLOUDFLARE_TUNNEL_CONFIG || DEFAULT_CONFIG_PATH;

// Ensure directory exists for local testing
const configDir = path.dirname(CONFIG_PATH);
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// Create default file if it doesn't exist
if (!fs.existsSync(CONFIG_PATH)) {
  const defaultYaml = `tunnel: deploye
credentials-file: /home/subhan/.cloudflared/9e06ff7a-bfa7-4c32-b05b-71996231cd6c.json

ingress:
  - service: http_status:404
`;
  fs.writeFileSync(CONFIG_PATH, defaultYaml, 'utf8');
}

function readConfig() {
  const file = fs.readFileSync(CONFIG_PATH, 'utf8');
  // Use yaml library to parse preserving document structure where possible
  const doc = yaml.parseDocument(file);
  return doc;
}

function validateConfig(doc) {
  const json = doc.toJSON();
  if (!json || typeof json !== 'object') throw new Error("Invalid YAML structure");
  if (!json.tunnel) throw new Error("Missing 'tunnel' key");
  if (!json['credentials-file']) throw new Error("Missing 'credentials-file' key");
  if (!Array.isArray(json.ingress)) throw new Error("'ingress' must be an array");

  const lastRoute = json.ingress[json.ingress.length - 1];
  if (!lastRoute || lastRoute.service !== "http_status:404") {
    throw new Error("The last ingress route must be 'service: http_status:404'");
  }

  // Check duplicates
  const hostnames = new Set();
  const ports = new Set();

  for (const route of json.ingress) {
    if (route.hostname) {
      if (hostnames.has(route.hostname)) throw new Error(`Duplicate hostname found: ${route.hostname}`);
      hostnames.add(route.hostname);
    }
    if (route.service && (route.service.startsWith("http://localhost:") || route.service.startsWith("http://127.0.0.1:"))) {
      const port = route.service.split(":")[2];
      ports.add(port);
    }
  }
}

async function addRoute(hostname, port) {
  const fileContent = fs.readFileSync(CONFIG_PATH, 'utf8');
  const doc = yaml.parseDocument(fileContent);
  const ingressNode = doc.get('ingress');

  if (!ingressNode || !ingressNode.items) {
    throw new Error("Ingress section missing or invalid in config");
  }

  // Check if route exists
  const exists = doc.toJSON().ingress.some(i => i.hostname === hostname);
  if (exists) throw new Error(`Route for ${hostname} already exists`);

  const newRoute = doc.createNode({
    hostname: hostname,
    service: `http://127.0.0.1:${port}`
  });

  // Insert before the last item (which should be http_status:404)
  const len = ingressNode.items.length;
  ingressNode.items.splice(len - 1, 0, newRoute);

  validateConfig(doc);

  const newYaml = String(doc);

  // Backup before writing
  const backupPath = `${CONFIG_PATH}.backup_${Date.now()}`;
  fs.writeFileSync(backupPath, fileContent);

  fs.writeFileSync(CONFIG_PATH, newYaml);

  try {
    await restartTunnel();
  } catch (err) {
    // Do not rollback if it's just a restart permission issue. The config is valid.
    throw new Error(`Config saved, but failed to restart tunnel. Error: ${err.message}`);
  }
}

async function deleteRoute(hostname) {
  const fileContent = fs.readFileSync(CONFIG_PATH, 'utf8');
  const doc = yaml.parseDocument(fileContent);
  const ingressNode = doc.get('ingress');

  if (!ingressNode || !ingressNode.items) {
    throw new Error("Ingress section missing or invalid in config");
  }

  let indexToRemove = -1;
  const jsonIngress = doc.toJSON().ingress;
  for (let i = 0; i < jsonIngress.length; i++) {
    if (jsonIngress[i].hostname === hostname) {
      indexToRemove = i;
      break;
    }
  }

  if (indexToRemove === -1) {
    throw new Error(`Route for ${hostname} not found`);
  }

  ingressNode.items.splice(indexToRemove, 1);
  validateConfig(doc);

  const newYaml = String(doc);

  const backupPath = `${CONFIG_PATH}.backup_${Date.now()}`;
  fs.writeFileSync(backupPath, fileContent);

  fs.writeFileSync(CONFIG_PATH, newYaml);

  try {
    await restartTunnel();
  } catch (err) {
    // Do not rollback if it's just a restart permission issue.
    throw new Error(`Config saved, but failed to restart tunnel. Error: ${err.message}`);
  }
}

function getRoutes() {
  const doc = readConfig();
  const json = doc.toJSON();
  return json.ingress || [];
}

async function restartTunnel() {
  return new Promise((resolve, reject) => {
    if (isWindows) {
      console.log("Mocking Cloudflare tunnel restart on Windows");
      setTimeout(resolve, 500);
      return;
    }

    // First try pm2 restart tunnel (Since we now manage deployments tunnel via PM2)
    exec("pm2 restart tunnel", (err) => {
      if (!err) return resolve();

      // Fallback: Try systemctl (systemd-managed cloudflared)
      // Use sudo -n to prevent hanging on password prompt if sudo is not passwordless
      exec("sudo -n systemctl restart cloudflared", (err2) => {
        if (!err2) return resolve();

        // If systemctl and pm2 fail, we cannot reliably restart a systemd service without sudo.
        console.warn("Could not restart cloudflared via pm2 or systemctl. Manual restart required.");
        reject(new Error("Failed to restart tunnel automatically (requires PM2 or passwordless sudo). Please run 'pm2 restart tunnel' manually."));
      });
    });
  });
}

function getTunnelCname() {
  try {
    const doc = readConfig();
    const credFile = doc.toJSON()['credentials-file'];
    if (credFile) {
      const tunnelId = path.basename(credFile, '.json');
      return `${tunnelId}.cfargotunnel.com`;
    }
  } catch (e) { }
  return "tunnel.lootops.me"; // fallback
}

module.exports = {
  readConfig,
  validateConfig,
  addRoute,
  deleteRoute,
  getRoutes,
  restartTunnel,
  getTunnelCname,
  CONFIG_PATH
};
