const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const http = require('http');

const isWindows = os.platform() === 'win32';
const UPLOAD_PATH = process.env.UPLOAD_PATH || "/var/www/storage/uploads";
const DEPLOYMENTS_DIR = process.env.DEPLOYMENTS_DIR || (isWindows ? path.join(UPLOAD_PATH, "Websites") : "/var/www/storage/Websites");
const ANALYTICS_DIR = path.join(DEPLOYMENTS_DIR, "analytics");

if (!fs.existsSync(ANALYTICS_DIR)) {
  fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
}

function getStatsPath(projectId) {
  return path.join(ANALYTICS_DIR, `${projectId}.json`);
}

function readStats(projectId) {
  const p = getStatsPath(projectId);
  if (!fs.existsSync(p)) {
    return {
      views: 0,
      uniqueVisitors: 0,
      topPages: {},
      referrers: {},
      devices: {},
      browsers: {},
      countries: {},
      history: [] // [{ date: 'YYYY-MM-DD', views: 0, unique: 0 }]
    };
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveStats(projectId, stats) {
  fs.writeFileSync(getStatsPath(projectId), JSON.stringify(stats, null, 2));
}

function hashIP(ip, userAgent) {
  return crypto.createHash('sha256').update(`${ip}-${userAgent}-${new Date().toISOString().split('T')[0]}`).digest('hex');
}

function recordPageView(projectId, data, ip) {
  const stats = readStats(projectId) || {
    views: 0,
    uniqueVisitors: 0,
    topPages: {},
    referrers: {},
    devices: {},
    browsers: {},
    countries: {},
    history: []
  };

  const today = new Date().toISOString().split('T')[0];
  const visitorId = hashIP(ip, data.ua || '');

  // We need to keep a daily set of unique visitors to calculate accurately.
  // Instead of storing all hashes (which grows infinitely), we'll keep a temporary file for today's visitors.
  const todaySetPath = path.join(ANALYTICS_DIR, `${projectId}_${today}_visitors.json`);
  let todayVisitors = [];
  if (fs.existsSync(todaySetPath)) {
    try {
      todayVisitors = JSON.parse(fs.readFileSync(todaySetPath, 'utf8'));
    } catch (e) {}
  }
  
  let isUnique = false;
  if (!todayVisitors.includes(visitorId)) {
    isUnique = true;
    todayVisitors.push(visitorId);
    fs.writeFileSync(todaySetPath, JSON.stringify(todayVisitors));
    stats.uniqueVisitors += 1;
  }

  stats.views += 1;
  
  // Top pages
  const url = data.url || '/';
  const pathOnly = url.split('?')[0].replace(/^(?:\/\/|[^/]+)*\//, '/'); // Get just the path
  stats.topPages[pathOnly] = (stats.topPages[pathOnly] || 0) + 1;

  // Referrers
  const ref = data.ref || 'Direct';
  let refDomain = ref;
  try {
    if (ref !== 'Direct' && ref.startsWith('http')) {
      refDomain = new URL(ref).hostname;
    }
  } catch(e) {}
  stats.referrers[refDomain] = (stats.referrers[refDomain] || 0) + 1;

  // Browser & Device (Simple heuristic)
  const ua = (data.ua || '').toLowerCase();
  let browser = 'Unknown';
  if (ua.includes('firefox')) browser = 'Firefox';
  else if (ua.includes('edg')) browser = 'Edge';
  else if (ua.includes('chrome')) browser = 'Chrome';
  else if (ua.includes('safari') && !ua.includes('chrome')) browser = 'Safari';
  stats.browsers[browser] = (stats.browsers[browser] || 0) + 1;

  let device = 'Desktop';
  if (ua.includes('mobi') || ua.includes('android') || ua.includes('iphone')) device = 'Mobile';
  else if (ua.includes('ipad') || ua.includes('tablet')) device = 'Tablet';
  stats.devices[device] = (stats.devices[device] || 0) + 1;

  // OS
  let osType = 'Unknown';
  if (ua.includes('win')) osType = 'Windows';
  else if (ua.includes('mac')) osType = 'macOS';
  else if (ua.includes('linux')) osType = 'Linux';
  else if (ua.includes('android')) osType = 'Android';
  else if (ua.includes('iphone') || ua.includes('ipad')) osType = 'iOS';
  stats.os = stats.os || {};
  stats.os[osType] = (stats.os[osType] || 0) + 1;

  // Screen Resolution
  if (data.sw && data.sh) {
    const res = `${data.sw}x${data.sh}`;
    stats.resolutions = stats.resolutions || {};
    stats.resolutions[res] = (stats.resolutions[res] || 0) + 1;
  }

  // Average Load Speed (Rolling average)
  if (data.load && data.load > 0 && data.load < 60000) { // Ignore > 60s
    stats.avgLoadTime = stats.avgLoadTime || 0;
    stats.totalLoads = stats.totalLoads || 0;
    
    // Calculate new average: ((oldAvg * totalLoads) + newLoad) / (totalLoads + 1)
    const currentTotal = stats.avgLoadTime * stats.totalLoads;
    stats.totalLoads += 1;
    stats.avgLoadTime = Math.round((currentTotal + data.load) / stats.totalLoads);
  }

  // History
  let historyEntry = stats.history.find(h => h.date === today);
  if (!historyEntry) {
    historyEntry = { date: today, views: 0, unique: 0 };
    stats.history.push(historyEntry);
    if (stats.history.length > 30) stats.history.shift(); // Keep last 30 days
  }
  historyEntry.views += 1;
  if (isUnique) historyEntry.unique += 1;

  saveStats(projectId, stats);

  // Fetch location async for unique visitors to avoid rate limits
  if (isUnique && ip && ip !== '127.0.0.1' && ip !== '::1' && !ip.startsWith('192.168.') && !ip.startsWith('10.')) {
    http.get(`http://ip-api.com/json/${ip}`, (resp) => {
      let d = '';
      resp.on('data', (chunk) => { d += chunk; });
      resp.on('end', () => {
        try {
          const result = JSON.parse(d);
          if (result.status === 'success' && result.country) {
            const currentStats = readStats(projectId);
            if (currentStats) {
              currentStats.countries = currentStats.countries || {};
              currentStats.countries[result.country] = (currentStats.countries[result.country] || 0) + 1;
              saveStats(projectId, currentStats);
            }
          }
        } catch(e) {}
      });
    }).on('error', () => {});
  }
}

module.exports = {
  readStats,
  recordPageView
};
