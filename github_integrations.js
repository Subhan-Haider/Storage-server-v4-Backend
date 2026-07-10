const fs = require('fs');
const path = require('path');
const axios = require('axios');

const UPLOAD_PATH = process.env.UPLOAD_PATH || path.join(require('os').homedir(), "Media-Downloader");
const INTEGRATIONS_DIR = path.join(UPLOAD_PATH, "integrations");
const GITHUB_TOKEN_PATH = path.join(INTEGRATIONS_DIR, "github.json");

if (!fs.existsSync(INTEGRATIONS_DIR)) {
  fs.mkdirSync(INTEGRATIONS_DIR, { recursive: true });
}

function getGithubToken() {
  if (fs.existsSync(GITHUB_TOKEN_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(GITHUB_TOKEN_PATH, 'utf8'));
      return data.token || null;
    } catch(e) {
      return null;
    }
  }
  return null;
}

function saveGithubToken(token) {
  fs.writeFileSync(GITHUB_TOKEN_PATH, JSON.stringify({ token }));
}

async function fetchGithubRepos() {
  const token = getGithubToken();
  if (!token) throw new Error("GitHub token not found");

  try {
    const res = await axios.get("https://api.github.com/user/repos?per_page=100&sort=updated", {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json"
      }
    });
    return res.data;
  } catch (err) {
    throw new Error("Failed to fetch repositories from GitHub");
  }
}

async function fetchGithubBranches(repoFullName) {
  const token = getGithubToken();
  if (!token) throw new Error("GitHub token not found");

  try {
    const res = await axios.get(`https://api.github.com/repos/${repoFullName}/branches?per_page=100`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json"
      }
    });
    return res.data;
  } catch (err) {
    throw new Error(`Failed to fetch branches for ${repoFullName}`);
  }
}

async function exchangeCodeForToken(code) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET is missing in .env.local");
  }

  const res = await axios.post("https://github.com/login/oauth/access_token", {
    client_id: clientId,
    client_secret: clientSecret,
    code
  }, {
    headers: { Accept: "application/json" }
  });

  if (res.data.error) {
    throw new Error(res.data.error_description || res.data.error);
  }

  saveGithubToken(res.data.access_token);
  return res.data.access_token;
}

async function createGithubWebhook(repoFullName, webhookUrl) {
  // Try OAuth token first, fall back to PAT from .env
  const oauthToken = getGithubToken();
  const patToken = process.env.GITHUB_PAT;
  const token = oauthToken || patToken;
  
  if (!token) throw new Error("GitHub token not found. Please connect GitHub first.");

  try {
    const res = await axios.post(`https://api.github.com/repos/${repoFullName}/hooks`, {
      name: "web",
      active: true,
      events: ["push"],
      config: {
        url: webhookUrl,
        content_type: "json",
        insecure_ssl: "0"
      }
    }, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json"
      }
    });
    return res.data;
  } catch (err) {
    const ghError = err.response?.data;
    // If hook already exists, that's fine
    if (ghError?.errors?.find(e => e.message?.includes("already exists"))) {
      return { success: true, message: "Webhook already registered on this repository!" };
    }
    // Clear message for permission issues
    if (err.response?.status === 404) {
      throw new Error(`Repository "${repoFullName}" not found or your token lacks access. Make sure the repo exists and you have admin rights.`);
    }
    if (err.response?.status === 403 || err.response?.status === 401) {
      throw new Error(`Permission denied. Your GitHub token needs 'admin:repo_hook' scope. Please re-connect GitHub by clicking the Connect GitHub button.`);
    }
    throw new Error(`Failed to create webhook: ${ghError?.message || err.message}`);
  }
}

async function scanGithubRepo(repoFullName, branch = "main", rootDir = "") {
  const token = getGithubToken() || process.env.GITHUB_PAT;
  if (!token) throw new Error("GitHub token not found");

  const pathUrl = rootDir && rootDir !== "./" ? rootDir.replace(/^\.\//, "") : "";
  const url = `https://api.github.com/repos/${repoFullName}/contents/${pathUrl}?ref=${branch}`;

  try {
    const res = await axios.get(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json"
      }
    });

    const files = Array.isArray(res.data) ? res.data : [res.data];
    const fileNames = files.map(f => f.name);

    let framework = "static";
    let installCmd = "";
    let buildCmd = "";
    let startCmd = "";

    if (fileNames.includes("package.json")) {
      const pkgFile = files.find(f => f.name === "package.json");
      if (pkgFile && pkgFile.download_url) {
        const pkgRes = await axios.get(pkgFile.download_url);
        const pkg = pkgRes.data;
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        
        if (deps.next) framework = "nextjs";
        else if (deps.astro) framework = "astro";
        else if (deps.react || deps["react-dom"]) framework = "react";
        else if (deps.vue) framework = "vue";
        else if (deps.express) framework = "express";
        else if (deps.vite) framework = "vite";
        else framework = "node";

        installCmd = "npm install";
        if (framework !== "node" && framework !== "express") {
          buildCmd = pkg.scripts?.build ? "npm run build" : "";
        }
        startCmd = pkg.scripts?.start ? "npm start" : (framework === "node" ? `node ${pkg.main || "index.js"}` : "");
      }
    } else if (fileNames.includes("requirements.txt") || fileNames.includes("manage.py")) {
      framework = "python";
      installCmd = "pip install -r requirements.txt";
    }

    return { framework, installCmd, buildCmd, startCmd };
  } catch (err) {
    throw new Error(`Failed to scan repository: ${err.message}`);
  }
}

module.exports = {
  getGithubToken,
  saveGithubToken,
  fetchGithubRepos,
  fetchGithubBranches,
  exchangeCodeForToken,
  createGithubWebhook,
  scanGithubRepo
};
