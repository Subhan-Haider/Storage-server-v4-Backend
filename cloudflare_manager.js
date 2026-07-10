const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('yaml');
const { exec } = require('child_process');

const isWindows = os.platform() === 'win32';
const DEFAULT_CONFIG_PATH = isWindows 
  ? path.join(os.homedir(), '.cloudflared', 'lootops-storage-config.yml')
  : '/home/subhan/.cloudflared/lootops-storage-config.yml';

const CONFIG_PATH = process.env.CLOUDFLARE_TUNNEL_CONFIG || DEFAULT_CONFIG_PATH;

// Ensure directory exists for local testing
const configDir = path.dirname(CONFIG_PATH);
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// Create default file if it doesn't exist
if (!fs.existsSync(CONFIG_PATH)) {
  const defaultYaml = `tunnel: efa5f037-2b60-4aa9-91f3-d9b1e4c489e5
credentials-file: /home/subhan/.cloudflared/efa5f037-2b60-4aa9-91f3-d9b1e4c489e5.json

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
    if (route.service && route.service.startsWith("http://localhost:")) {
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
    service: `http://localhost:${port}`
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
    // Rollback
    fs.writeFileSync(CONFIG_PATH, fileContent);
    throw new Error(`Failed to restart tunnel, rolled back config. Error: ${err.message}`);
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
    fs.writeFileSync(CONFIG_PATH, fileContent);
    throw new Error(`Failed to restart tunnel, rolled back config. Error: ${err.message}`);
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
    
    // Try systemctl first (systemd-managed cloudflared)
    exec("sudo systemctl restart cloudflared", (err) => {
      if (!err) return resolve();
      
      // Try pm2 restart tunnel (PM2-managed cloudflared, named "tunnel")
      exec("pm2 restart tunnel", (err2) => {
        if (!err2) return resolve();
        
        // Try cloudflared tunnel run as last resort
        const tunnelName = process.env.CLOUDFLARE_TUNNEL_NAME || "lootops-storage";
        exec(`cloudflared tunnel run ${tunnelName}`, (err3) => {
          if (!err3) return resolve();
          // If all restart methods fail, reject with clear message
          reject(new Error(`Failed to restart tunnel: ${err3.message}. Config was updated but tunnel needs manual restart.`));
        });
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
  } catch(e) {}
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
