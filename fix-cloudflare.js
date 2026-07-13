const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('yaml');
const { execSync } = require('child_process');

const isWindows = os.platform() === 'win32';
const CONFIG_PATH = isWindows
  ? path.join(os.homedir(), '.cloudflared', 'deployments-config.yml')
  : '/home/subhan/.cloudflared/deployments-config.yml';

try {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log("No Cloudflare config found at:", CONFIG_PATH);
    process.exit(0);
  }

  const fileContent = fs.readFileSync(CONFIG_PATH, 'utf8');
  const doc = yaml.parseDocument(fileContent);
  const ingressNode = doc.get('ingress');

  if (ingressNode && ingressNode.items) {
    let changed = false;
    let backendRouteExists = false;
    
    ingressNode.items.forEach(item => {
      if (item.has('hostname') && item.get('hostname') === 'storage.subhan.tech') {
        backendRouteExists = true;
      }
      if (item.has('service')) {
        let svc = item.get('service');
        if (typeof svc === 'string' && svc.startsWith('http://localhost:')) {
          item.set('service', svc.replace('http://localhost:', 'http://127.0.0.1:'));
          changed = true;
        }
      }
    });

    if (!backendRouteExists) {
      console.log("Adding storage.subhan.tech route for backend (port 5000)...");
      const newRoute = doc.createNode({
        hostname: 'storage.subhan.tech',
        service: 'http://127.0.0.1:5000'
      });
      ingressNode.items.splice(ingressNode.items.length - 1, 0, newRoute);
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(CONFIG_PATH, String(doc), 'utf8');
      console.log("✅ Fixed localhost -> 127.0.0.1 and added storage.subhan.tech");
      try {
        console.log("Restarting tunnel...");
        execSync("pm2 restart tunnel", { stdio: 'inherit' });
      } catch(e) {
        console.log("Failed to restart tunnel with PM2. Trying systemctl...");
        execSync("sudo -n systemctl restart cloudflared", { stdio: 'inherit' });
      }
      console.log("✅ Tunnel restarted successfully!");
    } else {
      console.log("✅ Configuration already correct.");
    }
  }
} catch (error) {
  console.error("Error fixing config:", error.message);
}
