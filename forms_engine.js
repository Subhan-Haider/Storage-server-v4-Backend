const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const isWindows = process.platform === 'win32';

function getUploadPath() {
  return process.env.UPLOAD_PATH || (isWindows ? path.join(__dirname, "../uploads") : "/var/www/storage/uploads");
}

function getFormsPath(projectId) {
  return path.join(getUploadPath(), "deployments", projectId, "forms.json");
}

function ensureFormsFile(projectId) {
  const formsPath = getFormsPath(projectId);
  if (!fs.existsSync(formsPath)) {
    fs.mkdirSync(path.dirname(formsPath), { recursive: true });
    fs.writeFileSync(formsPath, JSON.stringify([]));
  }
  return formsPath;
}

function recordSubmission(projectId, payload, ip) {
  const formsPath = ensureFormsFile(projectId);
  try {
    const data = JSON.parse(fs.readFileSync(formsPath, 'utf8'));
    
    // Extract redirect URL if present
    let redirectUrl = null;
    if (payload._redirect) {
      redirectUrl = payload._redirect;
      delete payload._redirect;
    }

    const submission = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ip: ip || 'unknown',
      data: payload
    };

    data.push(submission);
    fs.writeFileSync(formsPath, JSON.stringify(data, null, 2));
    
    return { success: true, redirectUrl };
  } catch (err) {
    console.error(`[FormsEngine] Error recording submission for project ${projectId}:`, err.message);
    return { success: false, error: err.message };
  }
}

function readForms(projectId) {
  const formsPath = getFormsPath(projectId);
  if (!fs.existsSync(formsPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(formsPath, 'utf8'));
  } catch (err) {
    return [];
  }
}

module.exports = {
  recordSubmission,
  readForms
};
