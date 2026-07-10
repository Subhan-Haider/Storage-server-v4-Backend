const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const os = require("os");
const crypto = require("crypto");

const isWindows = os.platform() === 'win32';

// Cross-platform helpers
function rmrf(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function cpr(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });
}

const UPLOAD_PATH = process.env.UPLOAD_PATH || "/var/www/storage/uploads";
const DEPLOYMENTS_DIR = process.env.DEPLOYMENTS_DIR || (isWindows ? path.join(UPLOAD_PATH, "Websites") : "/var/www/storage/Websites");
const PROJECTS_DB_PATH = path.join(DEPLOYMENTS_DIR, "projects.json");
const LOGS_DIR = path.join(DEPLOYMENTS_DIR, "logs");
const BACKUPS_DIR = path.join(DEPLOYMENTS_DIR, "backups");
const APPS_DIR = process.env.WEBSITES_PATH || "/var/www/storage/Websites";

// Ensure directories exist
if (!fs.existsSync(DEPLOYMENTS_DIR)) fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });

function readProjects() {
  if (!fs.existsSync(PROJECTS_DB_PATH)) return [];
  try {
    const projects = JSON.parse(fs.readFileSync(PROJECTS_DB_PATH, "utf8"));
    // Automatic migration to multiple domains
    projects.forEach(p => {
      if (!Array.isArray(p.domains)) {
        p.domains = p.domains ? [p.domains] : (p.domain ? [p.domain] : []);
        delete p.domain;
      }
    });
    return projects;
  } catch (e) {
    return [];
  }
}

function writeProjects(projects) {
  fs.writeFileSync(PROJECTS_DB_PATH, JSON.stringify(projects, null, 2));
}

function getProject(id) {
  return readProjects().find(p => p.id === id);
}

function updateProject(id, updates) {
  const projects = readProjects();
  const idx = projects.findIndex(p => p.id === id);
  if (idx !== -1) {
    projects[idx] = { ...projects[idx], ...updates, updatedAt: new Date().toISOString() };
    writeProjects(projects);
    return projects[idx];
  }
  return null;
}

function deleteProject(id) {
  const projects = readProjects();
  const newProjects = projects.filter(p => p.id !== id);
  writeProjects(newProjects);
}

function createProject(data) {
  const projects = readProjects();
  const newProject = {
    id: crypto.randomUUID(),
    name: data.name,
    description: data.description || "",
    repository: data.repository,
    branch: data.branch || "main",
    runtime: data.runtime || "node",
    framework: data.framework || "unknown",
    domains: data.domains || [],
    status: "idle", // idle, building, running, failed, stopped
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastDeployment: null,
    env: data.env || {},
    port: null,
    rootDir: data.rootDir || "",
    installCmd: data.installCmd || "",
    buildCmd: data.buildCmd || "",
    startCmd: data.startCmd || ""
  };
  projects.push(newProject);
  writeProjects(projects);
  return newProject;
}

function appendLog(projectId, message, type = "info") {
  const logFile = path.join(LOGS_DIR, `${projectId}.log`);
  const logLine = `[${new Date().toISOString()}] [${type.toUpperCase()}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, logLine);
  } catch(e) {}
}

async function findFreePort(start = 10000, end = 20000) {
  const net = require("net");
  
  // First, get all ports currently assigned to any project (running or stopped)
  const projects = readProjects();
  const assignedPorts = new Set(projects.map(p => p.port).filter(Boolean));

  const isPortFree = (port) => new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
  });

  for (let port = start; port <= end; port++) {
    if (assignedPorts.has(port)) continue; // Skip ports assigned to stopped projects
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error("No free ports available");
}

async function checkPortAvailability(port) {
  const net = require("net");
  const projects = readProjects();
  const assignedPorts = new Set(projects.map(p => Number(p.port)).filter(Boolean));
  
  if (assignedPorts.has(Number(port))) return false;
  
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
  });
}

async function executeCommand(command, cwd, projectId) {
  return new Promise((resolve, reject) => {
    appendLog(projectId, `Executing: ${command}`, "cmd");
    const child = spawn(command, { 
      cwd, 
      shell: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    
    child.stdout.on("data", (data) => {
      fs.appendFileSync(path.join(LOGS_DIR, `${projectId}.log`), data.toString());
    });
    
    child.stderr.on("data", (data) => {
      fs.appendFileSync(path.join(LOGS_DIR, `${projectId}.log`), data.toString());
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with code ${code}`));
    });
  });
}

// Helper to extract just the base repository URL in case user pasted a /blob/ or /tree/ link
function sanitizeRepoUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('github.com') || parsed.hostname.includes('gitlab.com')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        // Strip .git if present to normalize, we can append it later or leave as is (git clone works without it)
        let repo = parts[1];
        if (repo.endsWith('.git')) repo = repo.slice(0, -4);
        parsed.pathname = `/${parts[0]}/${repo}`;
        return parsed.toString();
      }
    }
  } catch (e) {}
  return url;
}

async function detectFramework(projectPath) {
  const pkgPath = path.join(projectPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = require(pkgPath);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) return "nextjs";
    if (deps.astro) return "astro";
    if (deps.react || deps["react-dom"]) return "react";
    if (deps.vue) return "vue";
    if (deps.express) return "express";
    if (deps.vite) return "vite";
    return "node";
  }
  // Python check
  if (fs.existsSync(path.join(projectPath, "requirements.txt")) || fs.existsSync(path.join(projectPath, "manage.py"))) {
    return "python";
  }
  return "static";
}

// Cloudflare integration replaces Nginx
const cloudflareManager = require('./cloudflare_manager');

async function deployProject(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error("Project not found");

  try {
    updateProject(projectId, { status: "building" });
    appendLog(projectId, `Starting deployment for ${project.name}...`, "info");

    const projectDir = path.join(APPS_DIR, projectId);
    const tempDir = path.join(APPS_DIR, `${projectId}_temp`);
    
    // Ensure clean temp dir
    try { rmrf(tempDir); } catch(e) {}
    
    // If project already exists, copy to temp dir to speed up clone/pull
    if (fs.existsSync(projectDir)) {
      appendLog(projectId, `Copying existing project to temporary build directory...`, "info");
      cpr(projectDir, tempDir);
    }

    // 1. Git Clone or Pull (in TEMP DIR)
    let repoUrl = sanitizeRepoUrl(project.repository);
    const githubIntegrations = require('./github_integrations');
    const token = githubIntegrations.getGithubToken();
    let cloneUrl = repoUrl;
    if (token && cloneUrl.includes("github.com") && !cloneUrl.includes("@")) {
      cloneUrl = cloneUrl.replace("https://github.com/", `https://${token}@github.com/`);
    }

    if (!fs.existsSync(path.join(tempDir, ".git"))) {
      appendLog(projectId, `Cloning repository: ${repoUrl}...`, "info");
      try {
        await executeCommand(`git clone -b ${project.branch} ${cloneUrl} ${projectId}_temp`, APPS_DIR, projectId);
      } catch (cloneErr) {
        if (cloneErr.message && (cloneErr.message.includes("403") || cloneErr.message.includes("access") || cloneErr.message.includes("not granted"))) {
          appendLog(projectId, `Token-based clone failed. Trying public clone...`, "warn");
          try {
            await executeCommand(`git clone -b ${project.branch} ${repoUrl} ${projectId}_temp`, APPS_DIR, projectId);
          } catch (pubErr) {
            throw new Error(`Cannot access repository. This may be a private repo.\nFix: Go to Settings → Git Integration → click 'Connect GitHub' to refresh your token.`);
          }
        } else {
          throw cloneErr;
        }
      }
    } else {
      appendLog(projectId, `Pulling latest changes from ${project.branch} into temp directory...`, "info");
      try {
        await executeCommand(`git fetch origin`, tempDir, projectId);
        await executeCommand(`git checkout ${project.branch}`, tempDir, projectId);
        await executeCommand(`git pull ${cloneUrl} ${project.branch}`, tempDir, projectId);
      } catch (err) {
        appendLog(projectId, `Failed to switch/pull branch, performing fresh clone...`, "warn");
        try { rmrf(tempDir); } catch(e) {}
        await executeCommand(`git clone -b ${project.branch} ${cloneUrl} ${projectId}_temp`, APPS_DIR, projectId);
      }
    }

    // Auto-detect root directory if not specified
    let autoRootDir = project.rootDir;
    if (!autoRootDir) {
      try {
        const items = fs.readdirSync(tempDir).filter(f => f !== '.git' && f !== '.github');
        if (!items.includes("package.json") && !items.includes("index.html") && !items.includes("requirements.txt")) {
          const dirs = items.filter(f => fs.statSync(path.join(tempDir, f)).isDirectory());
          const files = items.filter(f => fs.statSync(path.join(tempDir, f)).isFile());
          
          if (dirs.length === 1 && !["node_modules", "public", "dist", "build"].includes(dirs[0])) {
            const harmlessFiles = ["readme.md", "license", "license.md", ".gitignore", "dockerfile"];
            if (files.every(f => harmlessFiles.includes(f.toLowerCase()))) {
              autoRootDir = dirs[0];
            }
          }
          
          if (!autoRootDir) {
            for (const dir of dirs) {
              const dirPath = path.join(tempDir, dir);
              if (fs.existsSync(path.join(dirPath, "package.json")) || fs.existsSync(path.join(dirPath, "index.html"))) {
                autoRootDir = dir;
                break;
              }
            }
          }
        }
      } catch (e) {}

      if (autoRootDir) {
        appendLog(projectId, `Automatically detected Root Directory: ${autoRootDir}`, "info");
        updateProject(projectId, { rootDir: autoRootDir });
        project.rootDir = autoRootDir;
      }
    }

    // Adjust working directory
    const workingDir = project.rootDir ? path.join(tempDir, project.rootDir) : tempDir;
    
    // Inject Environment Variables into .env file before build
    if (project.env && Object.keys(project.env).length > 0) {
      appendLog(projectId, `Writing environment variables to .env file...`, "info");
      const envContent = Object.entries(project.env)
        .map(([key, val]) => `${key}=${val}`)
        .join('\n');
      fs.writeFileSync(path.join(workingDir, '.env'), envContent);
    }

    // 2. Framework Detection
    const framework = await detectFramework(workingDir);
    updateProject(projectId, { framework });
    appendLog(projectId, `Detected framework: ${framework} in ${workingDir}`, "info");

    // 3. Port Allocation
    let port = project.port;
    if (!port) {
      port = await findFreePort();
      updateProject(projectId, { port });
      appendLog(projectId, `Allocated port: ${port}`, "info");
    }

    // 4. Install & Build inside TEMP DIR
    if (["nextjs", "react", "vue", "vite", "express", "node", "astro"].includes(framework)) {
      appendLog(projectId, `Installing dependencies...`, "info");
      const installCmd = project.installCmd || "npm install --legacy-peer-deps";
      await executeCommand(installCmd, workingDir, projectId);
      
      if (framework !== "node" && framework !== "express") {
         appendLog(projectId, `Building project...`, "info");
         // Hotfix: Next.js 15/16 known bug with global-error and Turbopack
         if (framework === 'nextjs') {
           const appDirSrc = path.join(workingDir, 'src', 'app');
           const appDirRoot = path.join(workingDir, 'app');
           
           [
             path.join(appDirSrc, 'global-error.tsx'),
             path.join(appDirSrc, 'global-error.jsx'),
             path.join(appDirRoot, 'global-error.tsx'),
             path.join(appDirRoot, 'global-error.jsx')
           ].forEach(file => {
             if (fs.existsSync(file)) {
               appendLog(projectId, `Hotfix: Removing ${path.basename(file)} to bypass Next.js build bug`, "warn");
               fs.unlinkSync(file);
             }
           });
         }

         // DO NOT catch the error. If build fails, it will skip Atomic Swap and throw to the catch block!
         const buildCmd = project.buildCmd || "npm run build";
         await executeCommand(buildCmd, workingDir, projectId);
      }
    } else if (framework === "python") {
      appendLog(projectId, `Installing Python dependencies...`, "info");
      const installCmd = project.installCmd || "pip install -r requirements.txt";
      await executeCommand(installCmd, workingDir, projectId);
    }

    // ATOMIC SWAP - Build Succeeded!
    appendLog(projectId, `Build successful! Performing atomic swap...`, "success");

    // Backup current live project
    if (fs.existsSync(projectDir)) {
      const backupPath = path.join(BACKUPS_DIR, `${projectId}_last`);
      try { rmrf(backupPath); fs.renameSync(projectDir, backupPath); } catch(e) {
        appendLog(projectId, `Warning: Failed to backup old directory.`, "warn");
      }
    }

    // Move temp dir to live dir
    try {
      fs.renameSync(tempDir, projectDir);
    } catch(e) {
      // Fallback to copy/delete if cross-device link issues
      cpr(tempDir, projectDir);
      rmrf(tempDir);
    }

    // Recompute live working dir
    const liveWorkingDir = project.rootDir ? path.join(projectDir, project.rootDir) : projectDir;

    // 5. Start with PM2
    appendLog(projectId, `Starting application with PM2...`, "info");
    
    // Create .env file for the app
    const envVars = { ...project.env, PORT: port };
    const envString = Object.entries(envVars).map(([k,v]) => `${k}=${v}`).join("\n");
    fs.writeFileSync(path.join(liveWorkingDir, ".env"), envString);

    let startCmd = project.startCmd;
    if (!startCmd) {
      if (framework === "react" || framework === "vue" || framework === "vite") {
        const outDir = fs.existsSync(path.join(liveWorkingDir, "build")) ? "build" : "dist";
        startCmd = `npx serve -s ${outDir} -l ${port}`;
      } else if (framework === "astro") {
        startCmd = `npx serve -s dist -l ${port}`;
      } else if (framework === "node" || framework === "express") {
        try {
          const pkg = require(path.join(liveWorkingDir, "package.json"));
          startCmd = pkg.scripts?.start ? "npm start" : `node ${pkg.main || "index.js"}`;
        } catch(e) {
          startCmd = "node index.js";
        }
      } else if (framework === "static") {
        startCmd = `npx serve . -l ${port}`;
      } else {
        startCmd = "npm start";
      }
    }

    await executeCommand(`pm2 delete ${projectId}`, liveWorkingDir, projectId).catch(()=>{});
    
    const [cmdStr, ...argsArr] = startCmd.split(" ");
    const pm2WrapperCode = `
const { spawn } = require('child_process');
const customEnv = ${JSON.stringify(envVars)};
const child = spawn('${cmdStr}', ${JSON.stringify(argsArr)}, { 
  stdio: 'inherit', 
  shell: true, 
  env: { ...process.env, ...customEnv } 
});
child.on('close', code => process.exit(code));
    `;
    fs.writeFileSync(path.join(liveWorkingDir, "pm2-wrapper.js"), pm2WrapperCode);
    
    await executeCommand(`pm2 start pm2-wrapper.js --name ${projectId} --update-env`, liveWorkingDir, projectId);
    await executeCommand(`pm2 save`, liveWorkingDir, projectId);

    // 6. Cloudflare Tunnel
    if (project.domains && project.domains.length > 0) {
      appendLog(projectId, `Configuring Cloudflare Tunnels for ${project.domains.join(', ')}...`, "info");
      for (const domain of project.domains) {
        try {
          await cloudflareManager.addRoute(domain, port);
          appendLog(projectId, `Cloudflare Tunnel successfully updated for ${domain}.`, "info");
        } catch (err) {
          if (err.message.includes("already exists")) {
            appendLog(projectId, `Route for ${domain} already exists in tunnel config.`, "warn");
          } else {
            appendLog(projectId, `Cloudflare Tunnel error for ${domain}: ${err.message}`, "error");
            appendLog(projectId, `Deployment succeeded but tunnel needs manual config.`, "warn");
          }
        }
      }
    }

    updateProject(projectId, { 
      status: "running", 
      lastDeployment: new Date().toISOString() 
    });
    appendLog(projectId, `Deployment successful!`, "success");

  } catch (err) {
    appendLog(projectId, `Deployment failed: ${err.message}`, "error");
    
    // Rollback by cleaning up temp dir if it exists
    const tempDir = path.join(APPS_DIR, `${projectId}_temp`);
    if (fs.existsSync(tempDir)) {
      appendLog(projectId, `Rolling back: Deleting broken temporary build directory. Live app remains online.`, "info");
      try { rmrf(tempDir); } catch(e) {}
    }
    
    updateProject(projectId, { status: "failed" });
    throw err;
  }
}

async function stopProject(projectId) {
  await executeCommand(`pm2 stop ${projectId}`, os.tmpdir(), projectId).catch(()=> {});
  updateProject(projectId, { status: "stopped" });
}

async function rollbackProject(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error("Project not found");

  appendLog(projectId, `Starting rollback...`, "info");
  const projectDir = path.join(APPS_DIR, projectId);
  const backupPath = path.join(BACKUPS_DIR, `${projectId}_last`);

  if (!fs.existsSync(backupPath)) {
    throw new Error("No previous backup found to rollback to.");
  }

  rmrf(projectDir);
  cpr(backupPath, projectDir);
  
  const workingDir = project.rootDir ? path.join(projectDir, project.rootDir) : projectDir;
  
  // Create .env file for the app
  const envVars = { ...project.env, PORT: project.port };
  const envString = Object.entries(envVars).map(([k,v]) => `${k}=${v}`).join("\n");
  fs.writeFileSync(path.join(workingDir, ".env"), envString);
  
  await executeCommand(`pm2 restart ${projectId} --update-env`, workingDir, projectId);
  updateProject(projectId, { status: "running" });
  appendLog(projectId, `Rollback successful!`, "success");
}

module.exports = {
  readProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  deployProject,
  stopProject,
  rollbackProject,
  checkPortAvailability,
  sanitizeRepoUrl,
  LOGS_DIR,
  DEPLOYMENTS_DIR,
  APPS_DIR
};
