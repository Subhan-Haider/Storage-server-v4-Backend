const express = require("express");
const multer = require("multer");
const cors = require("cors");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { exec, spawn } = require("child_process");
const archiver = require("archiver");
const { fixWithAI } = require("./ai_engine");
const nodemailer = require("nodemailer");
const admin = require("./firebase-admin");
const cookieParser = require("cookie-parser");
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
const os = require("os");
const osUtils = require("os-utils");
const cron = require("node-cron");
const envPath = fs.existsSync(path.join(__dirname, ".env.local")) ? path.join(__dirname, ".env.local") : path.join(__dirname, "..", ".env.local");
require("dotenv").config({ path: envPath });
const watchdog = require("./watchdog");
const exiftool = require("node-exiftool");
const exiftoolBin = require("dist-exiftool");
const deploymentEngine = require("./deployment_engine");
const githubIntegrations = require("./github_integrations");
const cloudflareManager = require("./cloudflare_manager");

const app = express();
app.use(cookieParser());

// =====================
// SECURITY & MIDDLEWARE
// =====================
app.use(helmet({
  crossOriginResourcePolicy: false, // Allow images/files to be loaded from other origins
  frameguard: false,                // Allow iframes (needed for HTML live preview)
  contentSecurityPolicy: false,     // Disable default CSP which includes frame-ancestors 'self'
}));

let dynamicOrigins = []; // Loaded later from db.json

// Allow ALL origins — no domain restriction
app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// =====================
// CONFIG
// =====================
const PORT = process.env.PORT || 5000;
const UPLOAD_PATH = process.env.UPLOAD_PATH || "/var/www/storage/uploads";
const BASE_URL = process.env.SERVER_BASE_URL || "https://storage.lootops.me";
const API_KEY = process.env.API_KEY || "sh202620252009sh";

// =====================
// EMAIL CONFIG
// =====================
let transporter = null;
if (process.env.SMTP_ENABLED === "true") {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function sendSystemAlertEmail(title, message, emoji = "🚨", eventType = null) {
  sendDiscordAlert(title, message, emoji, eventType).catch(()=> {});

  if (!transporter) return;
  const db = readDb();
  const settings = db.settings || {};
  if (settings.emailNotificationsEnabled === false) return;
  // Per-event check
  if (eventType && settings.notificationPreferences) {
    if (settings.notificationPreferences[eventType] === false) return;
  }

  const emails = settings.notificationEmails || [process.env.ADMIN_EMAIL].filter(Boolean);
  if (emails.length === 0) return;

  const mailOptions = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: emails.join(", "),
    subject: `${emoji} System Alert: ${title}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px; background-color: #f1f5f9; color: #334155; text-align: center;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
          <div style="background-color: #e0e7ff; height: 60px; width: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px auto;">
            <span style="font-size: 30px;">${emoji}</span>
          </div>
          <h2 style="color: #4f46e5; font-weight: 800; font-size: 24px; margin-bottom: 10px; margin-top: 0;">${title}</h2>
          <p style="color: #64748b; font-size: 16px; margin-bottom: 30px; line-height: 1.5;">${message}</p>
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; text-align: left; margin-bottom: 30px;">
            <p style="margin: 0;"><strong style="color: #0f172a; width: 100px; display: inline-block;">Time:</strong> <span style="color: #475569;">${new Date().toLocaleString()}</span></p>
          </div>
          <a href="https://storage.lootops.me" style="display: inline-block; background-color: #4f46e5; color: #ffffff; font-weight: 600; font-size: 16px; text-decoration: none; padding: 14px 28px; border-radius: 8px; transition: background-color 0.2s;">Go to Dashboard</a>
        </div>
      </div>
    `
  };

  transporter.sendMail(mailOptions, (error) => {
    if (error) console.error("❌ Error sending alert email:", error);
  });
}

async function sendDiscordAlert(title, message, emoji = "🚨", eventType = null) {
  const db = readDb();
  
  if (db.settings?.discordNotificationsEnabled === false) return;
  
  if (eventType && db.settings?.notificationPreferences) {
    if (db.settings.notificationPreferences[eventType] === false) return;
  }

  const webhookUrl = db.settings?.discordWebhookUrl || process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  // Clean HTML from message for discord (e.g. <br> to \n, <code> to `)
  let cleanMessage = message.replace(/<br\s*\/?>/gi, '\n');
  cleanMessage = cleanMessage.replace(/<\/?code>/gi, '`');
  cleanMessage = cleanMessage.replace(/<[^>]+>/g, '');

  const payload = {
    embeds: [
      {
        title: `${emoji} System Alert: ${title}`,
        description: cleanMessage,
        color: 0x4f46e5,
        footer: {
          text: `LootOps Storage Server • ${new Date().toLocaleString()}`
        }
      }
    ]
  };

  try {
    const axios = require("axios");
    await axios.post(webhookUrl, payload, { timeout: 3000 });
  } catch (err) {
    console.error("❌ Discord webhook failed:", err.message);
  }
}

// =====================
// SYSTEM PRE-FLIGHT CHECKS (ffmpeg & sharp)
// =====================
let sharp;
try {
  sharp = require("sharp");
  console.log("⚡ Sharp image processing library loaded successfully.");
} catch (e) {
  console.warn("⚠️ Sharp not found. Image optimization and WebP generation will be disabled.");
}

let ffmpegPath = null;
exec("ffmpeg -version", (err) => {
  if (!err) {
    ffmpegPath = "ffmpeg";
    console.log("⚡ FFmpeg binary detected. Video compression features enabled.");
  } else {
    console.warn("⚠️ FFmpeg binary not found on path. Video compression features will be skipped.");
  }
});

// =====================
// MIDDLEWARE
// =====================
// Trust the first proxy (nginx) so X-Forwarded-For is read correctly
// Required for express-rate-limit to work behind a reverse proxy
app.set("trust proxy", 1);

app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "DELETE", "PUT", "PATCH"],
  allowedHeaders: ["Content-Type", "x-api-key", "Authorization", "x-mfa-token"]
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// RATE LIMITER (Uploads & Admin actions)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  validate: { xForwardedForHeader: false }, // Suppress ERR_ERL_UNEXPECTED_X_FORWARDED_FOR behind nginx
  message: { error: "Too many requests, please try again later." }
});

const visitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1, // Only 1 email per hour per IP
  validate: { xForwardedForHeader: false }, // Suppress ERR_ERL_UNEXPECTED_X_FORWARDED_FOR behind nginx
  message: { success: false, message: "Too many visits" }
});

// =====================
// LOCAL DATABASE (db.json)
// =====================
const DB_PATH = path.join(UPLOAD_PATH, "db.json");

function readDb() {
  const defaultDb = {
    files: {}, logs: [], shares: {}, users: {}, invites: {}, folders: {}, trash: {}, vaults: {}, webhookUrl: "", mfaCodes: {}, analytics: { totalUploads: 0, totalDownloads: 0, dailyStats: {} }, settings: { allowedOrigins: [], allowedEmails: ["setupg98@gmail.com", "support@subhan.tech"], notificationEmails: ["support@subhan.tech"], notificationsEnabled: true, customBaseUrl: "" }
  };
  if (!fs.existsSync(DB_PATH)) {
    return defaultDb;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    if (!data.files) data.files = {};
    if (!data.logs) data.logs = [];
    if (!data.shares) data.shares = {};
    if (!data.users) data.users = {};
    if (!data.invites) data.invites = {};
    if (!data.folders) data.folders = {};
    if (!data.trash) data.trash = {};
    if (!data.vaults) data.vaults = {};
    if (!data.webhookUrl) data.webhookUrl = "";
    if (!data.mfaCodes) data.mfaCodes = {};
    if (!data.analytics) data.analytics = { totalUploads: 0, totalDownloads: 0, dailyStats: {} };
    if (data.settings?.notificationsEnabled !== undefined) {
      data.settings.emailNotificationsEnabled = data.settings.notificationsEnabled;
      delete data.settings.notificationsEnabled;
    }
    
    if (!data.settings) data.settings = { allowedOrigins: [], allowedEmails: ["setupg98@gmail.com", "support@subhan.tech"], notificationEmails: ["support@subhan.tech"], emailNotificationsEnabled: true, discordNotificationsEnabled: true, customBaseUrl: "" };
    if (!data.settings.allowedEmails) data.settings.allowedEmails = ["setupg98@gmail.com", "support@subhan.tech"];
    if (!data.settings.notificationEmails) data.settings.notificationEmails = ["support@subhan.tech"];
    if (data.settings.emailNotificationsEnabled === undefined) data.settings.emailNotificationsEnabled = true;
    if (data.settings.discordNotificationsEnabled === undefined) data.settings.discordNotificationsEnabled = true;
    if (data.settings.customBaseUrl === undefined) data.settings.customBaseUrl = "";
    if (!data.settings.notificationPreferences) data.settings.notificationPreferences = {
      onUpload: true,
      onDelete: true,
      onLogin: true,
      onDownload: false,
      onShare: true,
    };

    // Auto-migrate legacy allowedEmails to the new users object as super_admins
    if (data.settings.allowedEmails && Array.isArray(data.settings.allowedEmails)) {
      let migrated = false;
      data.settings.allowedEmails.forEach(email => {
        if (!data.users[email]) {
          data.users[email] = {
            email: email,
            role: "super_admin",
            createdAt: new Date().toISOString()
          };
          migrated = true;
        }
      });
      // We don't delete allowedEmails yet, just in case they downgrade.
    }

    return data;
  } catch (e) {
    return defaultDb;
  }
}

// Load dynamic origins into memory initially
try {
  const db = readDb();
  dynamicOrigins = db.settings?.allowedOrigins || [];
} catch(e) {}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
  if (typeof rebuildFileCache === "function") {
    rebuildFileCache().catch(err => console.error("Cache rebuild failed in writeDb:", err));
  }
}

async function triggerWebhook(event, details) {
  const db = readDb();
  if (!db.webhookUrl) return;

  try {
    const axios = require("axios");
    const payload = {
      event,
      timestamp: new Date().toISOString(),
      details
    };
    await axios.post(db.webhookUrl, payload, { timeout: 3000 });
  } catch (err) {
    console.error("Webhook trigger failed:", err.message);
  }
}

function logEvent(event, details) {
  const db = readDb();
  db.logs.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    event,
    details
  });
  if (db.logs.length > 500) db.logs.pop(); // Keep last 500 logs
  writeDb(db);

  // Trigger Webhook in background
  triggerWebhook(event, details).catch(() => { });
}

// AUTH MIDDLEWARE — Verifies Firebase ID tokens or API Keys
const requireAuth = async (req, res, next) => {

  // 1. Check for API Key first (for programmatic access from other websites/scripts)
  const apiKey = req.headers["x-api-key"] || req.query.api_key;
  if (apiKey && apiKey === API_KEY) {
    req.user = { email: "api-key-user@system", uid: "api-key-access", role: "admin" };
    return next();
  }

  // 2. Fallback to Firebase ID Token (for the web dashboard)
  let token = req.query.token || null;
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  }

  if (!token) return res.status(401).json({ error: "Missing Firebase token or API key" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const dbData = readDb();
    const userRecord = dbData.users[decoded.email];

    if (!userRecord) {
      console.warn(`Unauthorized login attempt from: ${decoded.email}`);
      return res.status(403).json({ error: "Email not authorized", email: decoded.email });
    }

    req.userRole = userRecord.role;
    req.user = decoded;

    // --- 2FA ENFORCEMENT ---
    // Check if the user has 2FA enabled in Firestore
    const db = admin.firestore();
    const securityDoc = await db.collection("security").doc(decoded.uid).get();
    
    if (securityDoc.exists && securityDoc.data().mfaEnabled) {
      // Accept MFA token from cookie (same-domain) OR x-mfa-token header (Vercel proxy fallback)
      const mfaToken = req.cookies.mfa_token || req.headers["x-mfa-token"];
      if (!mfaToken) {
        return res.status(401).json({ error: "MFA required", mfaRequired: true });
      }

      // Verify the JWT MFA token
      try {
        const [uid, timestamp, signature] = mfaToken.split(".");
        if (uid !== decoded.uid) throw new Error("Invalid MFA token UID");
        
        // Very basic signature validation using project ID as secret
        const expectedSig = crypto.createHmac("sha256", process.env.FIREBASE_PROJECT_ID).update(`${uid}.${timestamp}`).digest("hex");
        if (signature !== expectedSig) throw new Error("Invalid MFA token signature");
        
        // Ensure token isn't expired (e.g., 24 hours)
        if (Date.now() - parseInt(timestamp) > 24 * 60 * 60 * 1000) {
          throw new Error("MFA token expired");
        }
      } catch (err) {
        return res.status(401).json({ error: "Invalid or expired MFA token", mfaRequired: true });
      }
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid Firebase token" });
  }
};

const requireSuperAdmin = (req, res, next) => {
  requireAuth(req, res, () => {
    if (req.userRole !== "super_admin") {
      return res.status(403).json({ error: "Super Admin privileges required." });
    }
    next();
  });
};

const requireAdmin = (req, res, next) => {
  requireAuth(req, res, () => {
    if (req.userRole !== "super_admin" && req.userRole !== "admin") {
      return res.status(403).json({ error: "Admin privileges required." });
    }
    next();
  });
};

const requirePermission = (action) => {
  return (req, res, next) => {
    // API Keys bypass granular permissions
    if (req.user && req.user.uid === "api-key-access") {
      return next();
    }

    const dbData = readDb();
    const userRecord = req.user ? dbData.users[req.user.email] : null;
    
    // If no user record found, they shouldn't even be here, but fail safe
    if (!userRecord) {
      return res.status(403).json({ error: "Access denied." });
    }
    
    const defaultPermissions = {
      super_admin: { canUpload: true, canDelete: true, canShare: true, canDownload: true },
      admin: { canUpload: true, canDelete: true, canShare: true, canDownload: true },
      home_member: { canUpload: true, canDelete: false, canShare: false, canDownload: true },
      guest: { canUpload: false, canDelete: false, canShare: false, canDownload: true }
    };

    const userPerms = {
      ...(defaultPermissions[req.userRole || userRecord.role] || defaultPermissions.guest),
      ...(userRecord.permissions || {})
    };

    if (!userPerms[action]) {
      return res.status(403).json({ error: `Permission denied: Requires ${action}` });
    }
    next();
  };
};

// =====================
// ALERTS (Login / Visit)
// =====================
app.post("/api/alerts/login", requireAuth, (req, res) => {
  const email = req.user?.email || "Unknown Admin";
  sendSystemAlertEmail("Admin Login", `Admin <strong>${email}</strong> has successfully logged into the dashboard.`, "🔐", "onLogin");
  res.json({ success: true });
});

app.post("/api/alerts/visit", visitLimiter, (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  sendSystemAlertEmail("Website Visit", `Someone visited the website from IP: <strong>${ip}</strong>.`, "👀");
  res.json({ success: true });
});

// =====================
// DIRECTORIES SETUP
// =====================
const THUMBNAIL_PATH = path.join(UPLOAD_PATH, "_thumbnails");
const TRASH_PATH = path.join(UPLOAD_PATH, "_trash");
const BACKUPS_PATH = path.join(UPLOAD_PATH, "_backups");

[UPLOAD_PATH, THUMBNAIL_PATH, TRASH_PATH, BACKUPS_PATH].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// =====================
// FFMEG VIDEO COMPRESSION UTILS
// =====================
const compressVideo = (srcPath, destPath) => {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return resolve(false);

    // Convert to webm/mp4 using medium-compression parameters
    const tempOut = destPath + ".tmp.mp4";
    const cmd = `ffmpeg -y -i "${srcPath}" -vcodec libx264 -crf 28 -preset fast -acodec aac -b:a 128k "${tempOut}"`;

    exec(cmd, (err) => {
      if (err) {
        if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
        return reject(err);
      }
      // Replace original file with compressed file
      fs.renameSync(tempOut, destPath);
      resolve(true);
    });
  });
};

// =====================
// SHARP IMAGE UTILS
// =====================
async function processImageUpload(srcPath, filename, folder) {
  if (!sharp) return null;

  const ext = path.extname(filename).toLowerCase();
  const baseName = path.basename(filename, ext);
  const webpFilename = `${Date.now()}-${baseName}.webp`;
  const folderPath = folder === "root" ? UPLOAD_PATH : path.join(UPLOAD_PATH, folder);
  const destWebpPath = path.join(folderPath, webpFilename);

  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  try {
    await sharp(srcPath)
      .resize(1920, 1080, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(destWebpPath);

    const thumbFilename = `${webpFilename}-thumb.webp`;
    await sharp(destWebpPath)
      .resize(300, 300, { fit: "cover" })
      .webp({ quality: 70 })
      .toFile(path.join(THUMBNAIL_PATH, thumbFilename));

    // fs.unlinkSync(srcPath); // Deferred to mlService or timeout

    return {
      name: webpFilename,
      thumbnail: thumbFilename
    };
  } catch (err) {
    console.error("Image processing error:", err);
    return null;
  }
}

// =====================
// FILE CACHE SYSTEM
// =====================
let fileCache = [];
let isCacheLoaded = false;

const fsPromises = fs.promises;

async function getAllFilesAsync(dirPath, db, arrayOfFiles = []) {
  const customBaseUrl = db.settings?.customBaseUrl || "";
  if (!fs.existsSync(dirPath)) return arrayOfFiles;

  try {
    const files = await fsPromises.readdir(dirPath);

    for (const file of files) {
      if (file === "db.json" || file === "_thumbnails" || file === "_trash" || file === "node_modules" || file === ".next" || file === ".git" || file === "deployments" || file === "_backups" || file.startsWith("watchdog_")) continue;

      const fullPath = path.join(dirPath, file);
      
      let stat;
      try {
        stat = await fsPromises.stat(fullPath);
      } catch (err) {
        // Skip broken symlinks or unreadable files gracefully without breaking the entire directory scan
        continue;
      }

      if (stat.isDirectory()) {
        await getAllFilesAsync(fullPath, db, arrayOfFiles);
      } else {
        const relativePath = path.relative(UPLOAD_PATH, fullPath).replace(/\\/g, "/");
        const folder = path.dirname(relativePath) === "." ? "root" : path.dirname(relativePath);
        const ext = path.extname(file).toLowerCase();

        let type = "unknown";
        if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".tiff"].includes(ext)) type = "image";
        else if ([".mp4", ".webm", ".mov", ".avi", ".mkv"].includes(ext)) type = "video";
        else if ([".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a"].includes(ext)) type = "audio";
        else if ([".pdf"].includes(ext)) type = "pdf";
        else if ([".html", ".htm"].includes(ext)) type = "html";
        else if ([".zip", ".tar", ".gz", ".rar", ".7z", ".tar.gz", ".tar.bz2"].includes(ext)) type = "archive";
        else if ([".apk", ".aab", ".exe", ".msi", ".dmg", ".pkg", ".deb", ".rpm", ".ipa", ".appx", ".appxbundle", ".msix"].includes(ext)) type = "installer";
        else if ([
          ".txt", ".md", ".css", ".js", ".ts", ".jsx", ".tsx",
          ".py", ".json", ".xml", ".csv", ".yaml", ".yml", ".sh", ".bash",
          ".php", ".rb", ".java", ".c", ".cpp", ".h", ".cs", ".go", ".rs",
          ".sql", ".graphql", ".env", ".toml", ".ini", ".cfg", ".log", ".spec"
        ].includes(ext)) type = "code";
        // Dotfiles with no extension (e.g. .gitignore) — treat as code
        else if (!ext && file.startsWith(".")) type = "code";

        const fileKey = `${folder}/${file}`;
        const meta = db.files[fileKey] || { isPublic: true, downloads: 0 };

        const thumbFilename = `${file}-thumb.webp`;
        let hasThumb = false;
        try {
          await fsPromises.access(path.join(THUMBNAIL_PATH, thumbFilename));
          hasThumb = true;
        } catch (e) { }

        arrayOfFiles.push({
          name: file,
          folder: folder,
          url: customBaseUrl ? `${customBaseUrl}/file-serve/${folder}/${file}` : `/file-serve/${folder}/${file}`,
          thumbnailUrl: hasThumb ? (customBaseUrl ? `${customBaseUrl}/thumbnails/${thumbFilename}` : `/thumbnails/${thumbFilename}`) : null,
          size: stat.size,
          type: type,
          createdAt: stat.birthtime,
          isPublic: meta.isPublic,
          downloads: meta.downloads || 0,
          pinned: !!meta.pinned,
          expiresAt: meta.expiresAt || null,
          hash: meta.hash || null,
          tags: meta.tags || [],
          note: meta.note || "",
          exif: meta.exif || null,
          faceIds: meta.faceIds || []
        });
      }
    }
  } catch (err) {
    console.error("Error reading directory in async scan:", err);
  }

  return arrayOfFiles;
}

async function rebuildFileCache() {
  try {
    const db = readDb();
    const newCache = await getAllFilesAsync(UPLOAD_PATH, db);
    // Sort by creation date descending by default
    fileCache = newCache.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    isCacheLoaded = true;
    console.log(`⚡ File cache rebuilt asynchronously. Total files cached: ${fileCache.length}`);
  } catch (err) {
    console.error("❌ Error rebuilding file cache:", err);
  }
}

// Initial cache build
rebuildFileCache().catch(console.error);

// Synchronous fallback for internal non-blocking scans (compatibility)
const getAllFiles = (dirPath, db, arrayOfFiles = []) => {
  if (!fs.existsSync(dirPath)) return arrayOfFiles;
  const files = fs.readdirSync(dirPath);
  files.forEach((file) => {
    if (file === "db.json" || file === "_thumbnails" || file === "_trash") return;
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, db, arrayOfFiles);
    } else {
      const relativePath = path.relative(UPLOAD_PATH, fullPath).replace(/\\/g, "/");
      const folder = path.dirname(relativePath) === "." ? "root" : path.dirname(relativePath);
      const ext = path.extname(file).toLowerCase();
      let type = "unknown";
      if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".tiff"].includes(ext)) type = "image";
      else if ([".mp4", ".webm", ".mov", ".avi", ".mkv"].includes(ext)) type = "video";
      else if ([".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a"].includes(ext)) type = "audio";
      else if ([".pdf"].includes(ext)) type = "pdf";
      else if ([".html", ".htm"].includes(ext)) type = "html";
      else if ([".zip", ".tar", ".gz", ".rar", ".7z", ".tar.gz", ".tar.bz2"].includes(ext)) type = "archive";
      else if ([".apk", ".aab", ".exe", ".msi", ".dmg", ".pkg", ".deb", ".rpm", ".ipa", ".appx", ".appxbundle", ".msix"].includes(ext)) type = "installer";
      else if ([
        ".txt", ".md", ".css", ".js", ".ts", ".jsx", ".tsx",
        ".py", ".json", ".xml", ".csv", ".yaml", ".yml", ".sh", ".bash",
        ".php", ".rb", ".java", ".c", ".cpp", ".h", ".cs", ".go", ".rs",
        ".sql", ".graphql", ".env", ".toml", ".ini", ".cfg", ".log", ".spec"
      ].includes(ext)) type = "code";
      // Dotfiles with no extension (e.g. .gitignore) — treat as code
      else if (!ext && file.startsWith(".")) type = "code";
      const fileKey = `${folder}/${file}`;
      const meta = db.files[fileKey] || { isPublic: true, downloads: 0 };
      const thumbFilename = `${file}-thumb.webp`;
      const hasThumb = fs.existsSync(path.join(THUMBNAIL_PATH, thumbFilename));
      arrayOfFiles.push({
        name: file,
        folder: folder,
        url: `/file-serve/${folder}/${file}`,
        thumbnailUrl: hasThumb ? `/thumbnails/${thumbFilename}` : null,
        size: fs.statSync(fullPath).size,
        type: type,
        createdAt: fs.statSync(fullPath).birthtime,
        isPublic: meta.isPublic,
        downloads: meta.downloads || 0,
        pinned: !!meta.pinned,
        expiresAt: meta.expiresAt || null,
        hash: meta.hash || null,
        tags: meta.tags || [],
        note: meta.note || "",
        exif: meta.exif || null,
        faceIds: meta.faceIds || []
      });
    }
  });
  return arrayOfFiles;
};

// =====================
// MULTER SETUP
// =====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folderName = req.body.folder ? req.body.folder.replace(/[^a-zA-Z0-9.\-_/]/g, "") : "";
    const targetDir = (!folderName || folderName === "root") ? UPLOAD_PATH : path.join(UPLOAD_PATH, folderName);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  }
});

const ALLOWED_EXTENSIONS = new Set([
  // Images
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".tiff",
  // Video
  ".mp4", ".webm", ".mov", ".avi", ".mkv",
  // Audio
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a",
  // Documents
  ".pdf", ".txt", ".md",
  // Code
  ".html", ".htm", ".css", ".js", ".ts", ".jsx", ".tsx",
  ".py", ".json", ".xml", ".csv", ".yaml", ".yml",
  ".sh", ".bash", ".php", ".rb", ".java", ".c", ".cpp",
  ".h", ".cs", ".go", ".rs", ".sql", ".graphql",
  ".env", ".toml", ".ini", ".cfg", ".log", ".spec",
  // Archives
  ".zip", ".tar", ".gz", ".rar", ".7z", ".tar.gz", ".tar.bz2",
  // Installers / Packages
  ".apk", ".aab", ".exe", ".msi", ".dmg", ".pkg", ".deb", ".rpm", ".ipa", ".appx", ".appxbundle", ".msix"
]);

// Common dotfiles (no extension — the full filename IS the identifier)
const ALLOWED_DOTFILES = new Set([
  ".gitignore", ".gitattributes", ".gitmodules", ".gitkeep",
  ".htaccess", ".htpasswd",
  ".npmignore", ".npmrc",
  ".eslintignore", ".eslintrc",
  ".prettierignore", ".prettierrc",
  ".babelrc", ".browserslistrc",
  ".editorconfig", ".nvmrc", ".node-version",
  ".dockerignore", ".env", ".env.local", ".env.example",
  ".travis.yml", ".gitlab-ci.yml"
]);

const fileFilter = (req, file, cb) => {
  const basename = path.basename(file.originalname).toLowerCase();
  const ext = path.extname(file.originalname).toLowerCase();

  // Handle dotfiles: path.extname('.gitignore') === '' but basename starts with '.'
  if (!ext && basename.startsWith(".")) {
    if (ALLOWED_DOTFILES.has(basename)) {
      return cb(null, true);
    }
    return cb(new Error(`Dotfile "${basename}" is not allowed.`));
  }

  if (ALLOWED_EXTENSIONS.has(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`File type "${ext || basename}" is not allowed.`));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// =====================
// RESCAN FILESYSTEM → db.json
// =====================
app.post("/admin/rescan-files", requireAuth, async (req, res) => {
  try {
    const db = readDb();
    const IGNORED_DIRS = new Set(["_thumbnails", "_trash", "_backups"]);
    let added = 0;
    let foldersAdded = 0;

    const scanDir = (dirPath, relFolder) => {
      if (!fs.existsSync(dirPath)) return;
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        if (entry === "db.json") continue;
        const fullPath = path.join(dirPath, entry);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          if (IGNORED_DIRS.has(entry)) continue;
          const folderKey = relFolder === "root" ? entry : `${relFolder}/${entry}`;
          // Register folder in db.folders
          if (!db.folders[folderKey]) {
            db.folders[folderKey] = { name: entry, createdAt: new Date().toISOString() };
            foldersAdded++;
          }
          // Recurse
          scanDir(fullPath, folderKey);
        } else {
          // Register file in db.files
          const fileKey = `${relFolder}/${entry}`;
          if (!db.files[fileKey]) {
            const ext = path.extname(entry).toLowerCase();
            let type = "unknown";
            if ([".jpg",".jpeg",".png",".gif",".webp",".svg",".ico",".bmp",".tiff"].includes(ext)) type = "image";
            else if ([".mp4",".webm",".mov",".avi",".mkv"].includes(ext)) type = "video";
            else if ([".mp3",".wav",".ogg",".flac",".aac",".m4a"].includes(ext)) type = "audio";
            else if ([".pdf"].includes(ext)) type = "pdf";
            else if ([".html",".htm"].includes(ext)) type = "html";
            else if ([".zip",".tar",".gz",".rar",".7z"].includes(ext)) type = "archive";
            else if ([".apk",".aab",".exe",".msi",".dmg",".pkg",".deb",".rpm",".ipa",".appx"].includes(ext)) type = "installer";
            else if ([".txt",".md",".css",".js",".ts",".jsx",".tsx",".py",".json",".xml",".csv",".yaml",".yml",".sh",".bash",".php",".rb",".java",".c",".cpp",".h",".cs",".go",".rs",".sql",".graphql",".env",".toml",".ini",".cfg",".log"].includes(ext)) type = "code";
            else if (!ext && entry.startsWith(".")) type = "code";

            db.files[fileKey] = {
              isPublic: true,
              downloads: 0,
              createdAt: stat.birthtime || new Date().toISOString(),
              size: stat.size,
              type,
              tags: [],
              note: "",
            };
            added++;
          }
        }
      }
    };

    scanDir(UPLOAD_PATH, "root");
    writeDb(db);

    res.json({
      success: true,
      message: `Rescan complete! Added ${added} file(s) and ${foldersAdded} folder(s) to the index.`,
      added,
      foldersAdded,
    });
  } catch (err) {
    console.error("Rescan error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// =====================
// FILE SERVING ROUTE
// =====================
app.get(/^\/file-serve\/(.*)/, async (req, res) => {
  const fullPath = decodeURIComponent(req.params[0]);
  const parts = fullPath.split("/");
  if (parts.length < 1) return res.status(404).json({ error: "Invalid path" });
  const name = parts.pop();
  const folder = parts.join("/");
  const resolvedUploadPath = path.resolve(UPLOAD_PATH);
  const filePath = folder === "root" ? path.join(resolvedUploadPath, name) : path.join(resolvedUploadPath, folder, name);

  if (!filePath.startsWith(resolvedUploadPath)) {
    return res.status(403).json({ error: "Access denied" });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const db = readDb();
  const fileKey = `${folder}/${name}`;
  const fileMeta = db.files[fileKey] || {};
  const isPrivate = fileMeta.isPublic === false;

  if (isPrivate) {
    const token = req.query.token;
    if (!token) {
      return res.status(401).json({ error: "Unauthorized: Private file" });
    }
    try {
      await admin.auth().verifyIdToken(token);
    } catch {
      return res.status(401).json({ error: "Unauthorized: Invalid token" });
    }
  }

  // Record download analytics
  try {
    const size = fs.statSync(filePath).size;
    const dateStr = new Date().toISOString().split("T")[0];
    db.analytics.totalDownloads = (db.analytics.totalDownloads || 0) + size;
    if (!db.analytics.dailyStats[dateStr]) {
      db.analytics.dailyStats[dateStr] = { uploads: 0, downloads: 0 };
    }
    db.analytics.dailyStats[dateStr].downloads = (db.analytics.dailyStats[dateStr].downloads || 0) + size;
  } catch (analyticsErr) {
    console.error("Failed to record download analytics:", analyticsErr);
  }

  db.files[fileKey] = {
    ...fileMeta,
    downloads: (fileMeta.downloads || 0) + 1
  };
  writeDb(db);

  // Serve file with Range support (required for video/audio streaming)
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const mimeType = (() => {
    const ext = path.extname(filePath).toLowerCase();
    const mimes = {
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg', '.ogv': 'video/ogg',
      '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.aac': 'audio/aac',
      '.m4a': 'audio/mp4', '.opus': 'audio/opus',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
      '.pdf': 'application/pdf', '.json': 'application/json', '.xml': 'application/xml',
      '.zip': 'application/zip', '.gz': 'application/gzip',
      '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
      '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/csv',
    };
    return mimes[ext] || 'application/octet-stream';
  })();

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Explicit download attachment endpoint
app.get(/^\/file-download\/(.*)/, async (req, res) => {
  const fullPath = decodeURIComponent(req.params[0]);
  const parts = fullPath.split("/");
  if (parts.length < 1) return res.status(404).json({ error: "Invalid path" });
  const name = parts.pop();
  const folder = parts.join("/");
  const resolvedUploadPath = path.resolve(UPLOAD_PATH);
  const filePath = folder === "root" ? path.join(resolvedUploadPath, name) : path.join(resolvedUploadPath, folder, name);

  if (!filePath.startsWith(resolvedUploadPath) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const db = readDb();
  const fileKey = `${folder}/${name}`;
  const fileMeta = db.files[fileKey] || {};
  const isPrivate = fileMeta.isPublic === false;

  if (isPrivate) {
    const token = req.query.token;
    if (!token) {
      return res.status(401).json({ error: "Unauthorized: Private file" });
    }
    try {
      await admin.auth().verifyIdToken(token);
    } catch {
      return res.status(401).json({ error: "Unauthorized: Invalid token" });
    }
  }

  // Record download analytics
  try {
    const size = fs.statSync(filePath).size;
    const dateStr = new Date().toISOString().split("T")[0];
    db.analytics.totalDownloads = (db.analytics.totalDownloads || 0) + size;
    if (!db.analytics.dailyStats[dateStr]) {
      db.analytics.dailyStats[dateStr] = { uploads: 0, downloads: 0 };
    }
    db.analytics.dailyStats[dateStr].downloads = (db.analytics.dailyStats[dateStr].downloads || 0) + size;
  } catch (analyticsErr) {
    console.error("Failed to record download analytics:", analyticsErr);
  }

  db.files[fileKey] = {
    ...fileMeta,
    downloads: (fileMeta.downloads || 0) + 1
  };
  writeDb(db);
  logEvent("FILE_DOWNLOADED", { folder, name });
  sendSystemAlertEmail("File Downloaded", `File <strong>${name}</strong> was downloaded from <strong>${folder || "root"}</strong>.`, "⬇️", "onDownload");

  res.download(filePath, name);
});

// Serve thumbnails publicly
app.use("/thumbnails", express.static(THUMBNAIL_PATH));

// ==============================
// 2FA (MFA) API
// ==============================

// Helper to cleanup expired mfa codes
function cleanupMfaCodes() {
  const db = readDb();
  let changed = false;
  const now = Date.now();
  for (const uid in db.mfaCodes) {
    if (db.mfaCodes[uid].expiresAt < now) {
      delete db.mfaCodes[uid];
      changed = true;
    }
  }
  if (changed) writeDb(db);
}

app.post("/api/auth/2fa/generate", requireAuth, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({
      name: `Storage Admin (${req.user.email})`,
    });

    qrcode.toDataURL(secret.otpauth_url, (err, dataUrl) => {
      if (err) return res.status(500).json({ error: "Error generating QR code" });
      res.json({
        secret: secret.base32,
        qrCode: dataUrl,
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/2fa/send-email", async (req, res) => {
  cleanupMfaCodes();
  try {
    let token = req.headers["authorization"];
    if (token && token.startsWith("Bearer ")) token = token.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Missing Firebase token" });
    
    const decoded = await admin.auth().verifyIdToken(token);
    
    if (!transporter) {
      return res.status(500).json({ error: "SMTP is not configured on the server." });
    }

    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    const db = readDb();
    db.mfaCodes[decoded.uid] = { code, expiresAt };
    writeDb(db);

    const mailOptions = {
      from: `"Storage Admin" <${process.env.SMTP_USER}>`,
      to: decoded.email,
      subject: `🔒 Your Security Code: ${code}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px; background-color: #0f172a; color: #f8fafc; text-align: center;">
          <div style="max-width: 500px; margin: 0 auto; background-color: #1e293b; padding: 40px; border-radius: 16px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.3); border: 1px solid #334155;">
            <div style="background-color: #312e81; height: 64px; width: 64px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px auto;">
              <span style="font-size: 32px;">🔒</span>
            </div>
            <h2 style="color: #818cf8; font-weight: 800; font-size: 26px; margin-bottom: 12px; margin-top: 0; letter-spacing: -0.5px;">Authentication Code</h2>
            <p style="color: #cbd5e1; font-size: 16px; margin-bottom: 32px; line-height: 1.6;">Please use the following 6-digit code to verify your identity and complete your login request.</p>
            
            <div style="font-family: 'Courier New', Courier, monospace; font-size: 42px; font-weight: 700; letter-spacing: 12px; color: #ffffff; background-color: #0f172a; padding: 24px; border-radius: 12px; display: inline-block; margin-bottom: 32px; border: 1px solid #475569; box-shadow: inset 0 2px 4px rgba(0,0,0,0.5);">
              ${code}
            </div>
            
            <div style="border-top: 1px solid #334155; padding-top: 24px;">
              <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 0;">This code will expire in <strong>10 minutes</strong>.<br>If you did not request this code, please ignore this email or contact support if you have concerns.</p>
            </div>
          </div>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to send email code" });
  }
});

app.post("/api/auth/2fa/verify-setup", requireAuth, async (req, res) => {
  try {
    const { token, secret, method = "app" } = req.body;
    
    let verified = false;

    if (method === "email") {
      const dbJson = readDb();
      const stored = dbJson.mfaCodes[req.user.uid];
      if (stored && stored.code === token && stored.expiresAt > Date.now()) {
        verified = true;
        delete dbJson.mfaCodes[req.user.uid];
        writeDb(dbJson);
      }
    } else {
      verified = speakeasy.totp.verify({
        secret,
        encoding: "base32",
        token,
        window: 1, // Allow ±30s clock drift
      });
    }

    if (verified) {
      const db = admin.firestore();
      await db.collection("security").doc(req.user.uid).set({
        mfaEnabled: true,
        mfaMethod: method,
        mfaSecret: method === "app" ? secret : null,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      res.json({ success: true });
    } else {
      res.status(400).json({ error: "Invalid code" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/2fa/disable", requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    const db = admin.firestore();
    const doc = await db.collection("security").doc(req.user.uid).get();
    
    if (!doc.exists || !doc.data().mfaEnabled) {
      return res.status(400).json({ error: "2FA is not enabled" });
    }

    const method = doc.data().mfaMethod || "app";
    let verified = false;

    if (method === "email") {
      // Verify against the stored email code
      const dbJson = readDb();
      const stored = dbJson.mfaCodes[req.user.uid];
      if (stored && stored.code === token && stored.expiresAt > Date.now()) {
        verified = true;
        delete dbJson.mfaCodes[req.user.uid];
        writeDb(dbJson);
      }
    } else {
      // Verify TOTP with ±30s clock drift tolerance
      verified = speakeasy.totp.verify({
        secret: doc.data().mfaSecret,
        encoding: "base32",
        token,
        window: 1,
      });
    }

    if (verified) {
      await db.collection("security").doc(req.user.uid).update({
        mfaEnabled: false,
        mfaSecret: null,
        updatedAt: new Date().toISOString()
      });
      res.json({ success: true });
    } else {
      res.status(400).json({ error: "Invalid code" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Note: This endpoint must NOT use requireAuth because the user might not have an MFA cookie yet
app.post("/api/auth/2fa/login", async (req, res) => {
  try {
    const { code } = req.body;
    let token = req.headers["authorization"];
    if (token && token.startsWith("Bearer ")) token = token.split(" ")[1];

    if (!token) return res.status(401).json({ error: "Missing Firebase token" });
    
    const decoded = await admin.auth().verifyIdToken(token);
    
    const db = admin.firestore();
    const doc = await db.collection("security").doc(decoded.uid).get();

    if (!doc.exists || !doc.data().mfaEnabled) {
      return res.status(400).json({ error: "2FA is not enabled for this user" });
    }

    const method = doc.data().mfaMethod || "app";
    let verified = false;

    if (method === "email") {
      const dbJson = readDb();
      const stored = dbJson.mfaCodes[decoded.uid];
      if (stored && stored.code === code && stored.expiresAt > Date.now()) {
        verified = true;
        delete dbJson.mfaCodes[decoded.uid];
        writeDb(dbJson);
      }
    } else {
      verified = speakeasy.totp.verify({
        secret: doc.data().mfaSecret,
        encoding: "base32",
        token: code,
        window: 1, // Allow ±30s clock drift between phone and server
      });
    }

    if (verified) {
      const timestamp = Date.now();
      const signature = crypto.createHmac("sha256", process.env.FIREBASE_PROJECT_ID).update(`${decoded.uid}.${timestamp}`).digest("hex");
      const mfaToken = `${decoded.uid}.${timestamp}.${signature}`;

      // Set as httpOnly cookie (works when Express is on same domain)
      res.cookie("mfa_token", mfaToken, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 24 * 60 * 60 * 1000 // 1 day
      });

      // Also return token in body so client can store in localStorage
      // (needed when Vercel proxy strips Set-Cookie headers)
      res.json({ success: true, mfaToken });
    } else {
      res.status(400).json({ error: "Invalid code" });
    }
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Helper endpoint to check if a user has 2FA enabled BEFORE full login
app.get("/api/auth/2fa/status", async (req, res) => {
  try {
    let token = req.query.token || req.headers["authorization"];
    if (token && token.startsWith("Bearer ")) token = token.split(" ")[1];
    
    if (!token) return res.status(401).json({ error: "Missing token" });
    const decoded = await admin.auth().verifyIdToken(token);
    
    const db = admin.firestore();
    const doc = await db.collection("security").doc(decoded.uid).get();
    
    res.json({ 
      mfaEnabled: doc.exists && doc.data().mfaEnabled,
      mfaMethod: doc.exists ? (doc.data().mfaMethod || "app") : null
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to check MFA status" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("mfa_token", { sameSite: "none", secure: true });
  res.json({ success: true });
});

// =====================
// CORE ENDPOINTS
// =====================

// 1. GET ALL FILES
app.get("/admin/files", requireAuth, (req, res) => {
  res.json(fileCache);
});

// 2. GET STATS WITH FOLDER BREAKDOWNS
app.get("/admin/stats", requireAuth, (req, res) => {
  try {
    const files = fileCache;
    const totalFiles = files.length;
    const totalSize = files.reduce((acc, file) => acc + file.size, 0);

    const folders = new Set();
    const folderStats = {};

    files.forEach(f => {
      folders.add(f.folder);
      if (!folderStats[f.folder]) {
        folderStats[f.folder] = { count: 0, sizeBytes: 0 };
      }
      folderStats[f.folder].count++;
      folderStats[f.folder].sizeBytes += f.size;
    });

    // Also detect empty folders on disk (non-recursive, single directory read, fast!)
    try {
      const items = fs.readdirSync(UPLOAD_PATH);
      items.forEach(item => {
        if (item === "_thumbnails" || item === "_trash" || item === "db.json") return;
        const fullPath = path.join(UPLOAD_PATH, item);
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            folders.add(item);
            if (!folderStats[item]) {
              folderStats[item] = { count: 0, sizeBytes: 0 };
            }
          }
        } catch (e) { }
      });
    } catch (e) { }

    let mostUploadedFolder = "None";
    let maxFiles = 0;
    Object.entries(folderStats).forEach(([name, data]) => {
      if (data.count > maxFiles && name !== "root") {
        mostUploadedFolder = name;
        maxFiles = data.count;
      }
    });

    let disk = null;
    try {
      const stat = fs.statfsSync(UPLOAD_PATH);
      const total = stat.blocks * stat.bsize;
      const free = stat.bfree * stat.bsize;
      disk = { total, free, used: total - free };
    } catch (e) {
      try {
        const stat = fs.statfsSync(__dirname);
        const total = stat.blocks * stat.bsize;
        const free = stat.bfree * stat.bsize;
        disk = { total, free, used: total - free };
      } catch (e2) {}
    }

    res.json({
      totalFiles,
      totalFolders: folders.size,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      mostUploadedFolder,
      filesByType: files.reduce((acc, file) => {
        acc[file.type] = (acc[file.type] || 0) + 1;
        return acc;
      }, {}),
      foldersBreakdown: folderStats,
      disk
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3b. GENERATE MISSING THUMBNAILS FOR EXISTING FILES
app.post("/admin/generate-thumbnails", requireAuth, async (req, res) => {
  if (!sharp) return res.status(503).json({ error: "Sharp not available on this server" });

  const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"]);
  let generated = 0;
  let skipped = 0;
  let errors = 0;

  async function scanDir(dir) {
    const items = await fsPromises.readdir(dir).catch(() => []);
    for (const item of items) {
      if (item === "_thumbnails" || item === "_trash" || item === "db.json") continue;
      const fullPath = path.join(dir, item);
      const stat = await fsPromises.stat(fullPath).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        await scanDir(fullPath);
      } else {
        const ext = path.extname(item).toLowerCase();
        if (!IMAGE_EXTS.has(ext)) continue;
        const thumbFilename = `${item}-thumb.webp`;
        const thumbPath = path.join(THUMBNAIL_PATH, thumbFilename);
        const thumbExists = await fsPromises.access(thumbPath).then(() => true).catch(() => false);
        if (thumbExists) { skipped++; continue; }
        try {
          await sharp(fullPath)
            .resize(300, 300, { fit: "cover" })
            .webp({ quality: 70 })
            .toFile(thumbPath);
          generated++;
        } catch (e) {
          console.error("Thumb gen error for", item, e.message);
          errors++;
        }
      }
    }
  }

  try {
    await scanDir(UPLOAD_PATH);
    await rebuildFileCache();
    res.json({ message: "Thumbnail generation complete", generated, skipped, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. UPLOAD FILE WITH DYNAMIC WEB-P & FFMPEG COMPRESSION
const requireUploadAuth = async (req, res, next) => {
  const providedKey = req.query.api_key || req.headers["x-api-key"];
  if (providedKey && providedKey === API_KEY) {
    req.user = { uid: "api-key-user", email: "api@system", isApiKey: true };
    return next();
  }
  return requireAuth(req, res, next);
};

app.post("/upload", apiLimiter, requireUploadAuth, requirePermission("canUpload"), (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    let finalFilename = req.file.filename;
    let folderName = req.body.folder ? req.body.folder.replace(/[^a-zA-Z0-9.\-_/]/g, "") : "root";
    let isImage = req.file.mimetype.startsWith("image/");
    let isVideo = req.file.mimetype.startsWith("video/");
    let hasThumb = false;

    // Extract EXIF Data before compression strips it
    let exifData = null;
    if (isImage) {
      try {
        const exifr = require("exifr");
        const parsedExif = await exifr.parse(req.file.path, { pick: ['latitude', 'longitude', 'DateTimeOriginal', 'Make', 'Model'] });
        if (parsedExif && (parsedExif.latitude || parsedExif.Make)) {
          exifData = {
            latitude: parsedExif.latitude,
            longitude: parsedExif.longitude,
            dateTimeOriginal: parsedExif.DateTimeOriginal,
            cameraMake: parsedExif.Make,
            cameraModel: parsedExif.Model
          };
          console.log(`📍 Extracted EXIF for ${req.file.filename}`);
        }
      } catch (exifErr) {
        console.error("Failed to parse EXIF:", exifErr.message);
      }
    }

    // Image WebP compression & thumb generation
    if (isImage && sharp) {
      const processed = await processImageUpload(req.file.path, req.file.filename, folderName);
      if (processed) {
        finalFilename = processed.name;
        hasThumb = true;
      }
    }

    // Trigger ML Face Recognition in the background
    if (isImage) {
      setTimeout(() => {
        const { detectAndGroupFaces } = require('./mlService');
        detectAndGroupFaces(
          req.file.path, // We need to use original path because WebP buffer isn't easily loaded by canvas
          `${folderName}/${finalFilename}`,
          readDb,
          writeDb
        );
      }, 2000);
    }

    // FFmpeg video compression
    if (isVideo && ffmpegPath) {
      try {
        console.log(`🎬 Compressing video background task started: ${finalFilename}`);
        await compressVideo(req.file.path, req.file.path);
        console.log(`✅ Compression succeeded for ${finalFilename}`);
      } catch (videoErr) {
        console.error("❌ Video compression error:", videoErr);
      }
    }

    const finalPath = folderName === "root"
      ? path.join(UPLOAD_PATH, finalFilename)
      : path.join(UPLOAD_PATH, folderName, finalFilename);

    // Compute file hash (SHA256)
    let fileHash = null;
    try {
      if (fs.existsSync(finalPath)) {
        const fileBuffer = fs.readFileSync(finalPath);
        fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
      }
    } catch (hashErr) {
      console.error("Hash calculation failed:", hashErr);
    }

    const fileSize = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : req.file.size;

    // Record upload analytics
    const db = readDb();
    const dateStr = new Date().toISOString().split("T")[0];
    db.analytics.totalUploads = (db.analytics.totalUploads || 0) + fileSize;
    if (!db.analytics.dailyStats[dateStr]) {
      db.analytics.dailyStats[dateStr] = { uploads: 0, downloads: 0 };
    }
    db.analytics.dailyStats[dateStr].uploads = (db.analytics.dailyStats[dateStr].uploads || 0) + fileSize;

    // Update DB
    const fileKey = `${folderName}/${finalFilename}`;
    db.files[fileKey] = {
      isPublic: true,
      downloads: 0,
      hash: fileHash,
      pinned: false,
      tags: [],
      note: "",
      expiresAt: null,
      exif: exifData,
      faceIds: []
    };
    writeDb(db);

    logEvent("FILE_UPLOAD", { folder: folderName, name: finalFilename, size: fileSize, sha256: fileHash });

    // Send System Alert
    sendSystemAlertEmail(
      "File Uploaded",
      `A new file <strong>${finalFilename}</strong> (${(fileSize / 1024 / 1024).toFixed(2)} MB) was uploaded to the <strong>${folderName}</strong> folder.`,
      "🚀",
      "onUpload"
    );

    // AI Auto-Tagging (Background OCR)
    if (isImage) {
      setTimeout(async () => {
        try {
          const Tesseract = require("tesseract.js");
          console.log(`🧠 Starting AI OCR for ${finalFilename}...`);
          const { data: { text } } = await Tesseract.recognize(finalPath, "eng");
          if (text && text.trim().length > 0) {
            // Extract meaningful alphanumeric words longer than 2 chars
            const words = text.replace(/[^a-zA-Z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2);
            const uniqueTags = [...new Set(words.map(w => w.toLowerCase()))];
            
            if (uniqueTags.length > 0) {
              const currentDb = readDb();
              const fKey = `${folderName}/${finalFilename}`;
              if (currentDb.files[fKey]) {
                currentDb.files[fKey].tags = [...new Set([...(currentDb.files[fKey].tags || []), ...uniqueTags])];
                writeDb(currentDb);
                console.log(`✅ AI OCR tagged ${finalFilename} with ${uniqueTags.length} keywords.`);
              }
            }
          }
        } catch (ocrErr) {
          console.error("❌ AI OCR failed:", ocrErr.message);
        }
      }, 500); // Small delay to ensure file is completely written and unlocked
    }

    res.json({
      success: true,
      name: finalFilename,
      folder: folderName,
      url: `/file-serve/${folderName}/${finalFilename}`,
      thumbnailUrl: hasThumb ? `/thumbnails/${finalFilename}-thumb.webp` : null,
      sha256: fileHash
    });
  });
});

// =====================
// FACES API
// =====================
app.get("/admin/faces", requireAuth, (req, res) => {
  const db = readDb();
  res.json(db.faces || []);
});

app.post("/admin/faces/rename", requireAuth, (req, res) => {
  const { id, name } = req.body;
  const db = readDb();
  if (!db.faces) return res.json({ success: false });
  const face = db.faces.find(f => f.id === id);
  if (face) {
    face.name = name;
    writeDb(db);
    return res.json({ success: true });
  }
  res.json({ success: false });
});

// Check if ML (face-api.js + canvas) is available on this server
app.get("/admin/faces/ml-status", requireAuth, (req, res) => {
  try {
    require.resolve("face-api.js");
    require.resolve("canvas");
    const modelsPath = path.join(__dirname, "models");
    const modelsExist = fs.existsSync(modelsPath) &&
      fs.existsSync(path.join(modelsPath, "ssd_mobilenetv1_model-weights_manifest.json"));
    res.json({ available: true, modelsReady: modelsExist });
  } catch (e) {
    res.json({ available: false, modelsReady: false, reason: e.message });
  }
});

// Scan ALL existing image files for faces (background job)
let scanAllInProgress = false;
app.post("/admin/faces/scan-all", requireAuth, async (req, res) => {
  if (scanAllInProgress) {
    return res.json({ success: false, message: "Scan already in progress." });
  }

  try {
    require.resolve("face-api.js");
    require.resolve("canvas");
  } catch (e) {
    return res.json({
      success: false,
      message: "face-api.js or canvas is not installed on this server. Run: npm install face-api.js canvas"
    });
  }

  const modelsPath = path.join(__dirname, "models");
  if (!fs.existsSync(modelsPath)) {
    return res.json({
      success: false,
      message: "AI models not downloaded. Run: node download-models.js"
    });
  }

  scanAllInProgress = true;
  res.json({ success: true, message: "Scan started in background. Check back in a few minutes." });

  // Run in background
  (async () => {
    try {
      const { detectAndGroupFaces } = require("./mlService");
      const db = readDb();
      const imageExts = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];
      const allFiles = fileCache.filter(f => {
        const ext = path.extname(f.name).toLowerCase();
        return imageExts.includes(ext);
      });

      console.log(`🤖 [SCAN-ALL] Starting face scan of ${allFiles.length} images...`);

      for (const file of allFiles) {
        const filePath = file.folder === "root"
          ? path.join(UPLOAD_PATH, file.name)
          : path.join(UPLOAD_PATH, file.folder, file.name);

        if (!fs.existsSync(filePath)) continue;

        const fileKey = `${file.folder}/${file.name}`;
        const meta = db.files[fileKey] || {};
        if (meta.faceIds && meta.faceIds.length > 0) continue; // Already scanned

        // Copy to a temp path to avoid mlService deleting the original
        const tempPath = filePath + ".facescan.tmp";
        try {
          fs.copyFileSync(filePath, tempPath);
          await detectAndGroupFaces(tempPath, fileKey, readDb, writeDb);
        } catch (e) {
          console.error(`❌ [SCAN-ALL] Failed for ${fileKey}:`, e.message);
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }

        // Small delay to avoid overloading the CPU
        await new Promise(r => setTimeout(r, 500));
      }

      console.log(`✅ [SCAN-ALL] Face scan complete!`);
    } catch (err) {
      console.error("❌ [SCAN-ALL] Fatal error:", err);
    } finally {
      scanAllInProgress = false;
    }
  })();
});

// Scan ALL existing image files for EXIF/GPS metadata (background job)
let scanExifInProgress = false;
app.post("/admin/map/scan-exif", requireAuth, async (req, res) => {
  if (scanExifInProgress) {
    return res.json({ success: false, message: "EXIF scan already in progress." });
  }

  let exifr;
  try {
    exifr = require("exifr");
  } catch (e) {
    return res.json({
      success: false,
      message: "exifr package is not installed. Run: npm install exifr"
    });
  }

  scanExifInProgress = true;
  res.json({ success: true, message: "EXIF scan started in background. Check back in a minute." });

  // Run in background
  (async () => {
    try {
      const db = readDb();
      const imageExts = [".jpg", ".jpeg", ".png", ".webp", ".heic"];
      const allFiles = fileCache.filter(f => {
        const ext = path.extname(f.name).toLowerCase();
        return imageExts.includes(ext);
      });

      console.log(`📍 [SCAN-EXIF] Starting EXIF scan of ${allFiles.length} images...`);

      let scannedCount = 0;
      let gpsCount = 0;

      for (const file of allFiles) {
        const filePath = file.folder === "root"
          ? path.join(UPLOAD_PATH, file.name)
          : path.join(UPLOAD_PATH, file.folder, file.name);

        if (!fs.existsSync(filePath)) continue;

        const fileKey = `${file.folder}/${file.name}`;
        if (!db.files[fileKey]) db.files[fileKey] = {};
        
        // Skip if we already successfully extracted GPS in the past
        if (db.files[fileKey].exif && db.files[fileKey].exif.latitude) continue;

        try {
          const parsedExif = await exifr.parse(filePath, { pick: ['latitude', 'longitude', 'DateTimeOriginal', 'Make', 'Model'] });
          if (parsedExif && (parsedExif.latitude || parsedExif.Make)) {
            db.files[fileKey].exif = {
              latitude: parsedExif.latitude,
              longitude: parsedExif.longitude,
              dateTimeOriginal: parsedExif.DateTimeOriginal,
              cameraMake: parsedExif.Make,
              cameraModel: parsedExif.Model
            };
            if (parsedExif.latitude) gpsCount++;
          }
          scannedCount++;
          // Save every 50 images to avoid losing progress
          if (scannedCount % 50 === 0) writeDb(db);
        } catch (e) {
          // File might not have EXIF or is corrupt
        }

        // Tiny delay
        await new Promise(r => setTimeout(r, 10));
      }

      writeDb(db); // Final save
      console.log(`✅ [SCAN-EXIF] EXIF scan complete! Found new GPS data for ${gpsCount} images.`);
    } catch (err) {
      console.error("❌ [SCAN-EXIF] Fatal error:", err);
    } finally {
      scanExifInProgress = false;
    }
  })();
});

// Scan ALL existing image files for OCR Tags (background job)
let scanTagsInProgress = false;
app.post("/admin/search/scan-tags", requireAuth, async (req, res) => {
  if (scanTagsInProgress) {
    return res.json({ success: false, message: "Tag scan already in progress." });
  }

  let Tesseract;
  try {
    Tesseract = require("tesseract.js");
  } catch (e) {
    return res.json({
      success: false,
      message: "tesseract.js is not installed. Run: npm install tesseract.js"
    });
  }

  scanTagsInProgress = true;
  res.json({ success: true, message: "Tag scan started in background. Check back in a few minutes." });

  // Run in background
  (async () => {
    try {
      const db = readDb();
      const imageExts = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];
      const allFiles = fileCache.filter(f => {
        const ext = path.extname(f.name).toLowerCase();
        return imageExts.includes(ext);
      });

      console.log(`🧠 [SCAN-TAGS] Starting OCR scan of ${allFiles.length} images...`);

      let scannedCount = 0;
      let taggedCount = 0;

      for (const file of allFiles) {
        const filePath = file.folder === "root"
          ? path.join(UPLOAD_PATH, file.name)
          : path.join(UPLOAD_PATH, file.folder, file.name);

        if (!fs.existsSync(filePath)) continue;

        const fileKey = `${file.folder}/${file.name}`;
        if (!db.files[fileKey]) db.files[fileKey] = {};
        
        // Skip if it already has tags
        if (db.files[fileKey].tags && db.files[fileKey].tags.length > 0) continue;

        try {
          const { data: { text } } = await Tesseract.recognize(filePath, "eng");
          if (text && text.trim().length > 0) {
            const words = text.replace(/[^a-zA-Z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2);
            const uniqueTags = [...new Set(words.map(w => w.toLowerCase()))];
            
            if (uniqueTags.length > 0) {
              db.files[fileKey].tags = uniqueTags;
              taggedCount++;
            }
          }
          scannedCount++;
          // Save every 20 images
          if (scannedCount % 20 === 0) writeDb(db);
        } catch (e) {
          // File might be corrupt or Tesseract failed
        }

        // Small delay to prevent locking the thread 100%
        await new Promise(r => setTimeout(r, 100));
      }

      writeDb(db); // Final save
      console.log(`✅ [SCAN-TAGS] OCR scan complete! Found tags for ${taggedCount} images.`);
    } catch (err) {
      console.error("❌ [SCAN-TAGS] Fatal error:", err);
    } finally {
      scanTagsInProgress = false;
    }
  })();
});

// 4. DELETE / SOFT-DELETE FILE
app.delete("/admin/file", requireAuth, requirePermission("canDelete"), (req, res) => {
  const { folder, name, force } = req.body;
  if (!name) return res.status(400).json({ error: "File name required" });

  const targetPath = folder && folder !== "root"
    ? path.join(UPLOAD_PATH, folder, name)
    : path.join(UPLOAD_PATH, name);

  if (!targetPath.startsWith(UPLOAD_PATH)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  if (fs.existsSync(targetPath)) {
    const db = readDb();
    const fileKey = `${folder || "root"}/${name}`;

    if (force) {
      // Hard delete (permanent physical deletion)
      fs.unlinkSync(targetPath);
      const thumbPath = path.join(THUMBNAIL_PATH, `${name}-thumb.webp`);
      if (fs.existsSync(thumbPath)) {
        fs.unlinkSync(thumbPath);
      }
      delete db.files[fileKey];
      writeDb(db);

      logEvent("FILE_HARD_DELETE", { folder, name });
      res.json({ success: true, message: "File permanently deleted" });
    } else {
      // Soft delete (Move to _trash directory)
      const trashedName = `${Date.now()}-${name}`;
      const destPath = path.join(TRASH_PATH, trashedName);

      fs.renameSync(targetPath, destPath);

      // Move thumbnail if it exists
      const thumbPath = path.join(THUMBNAIL_PATH, `${name}-thumb.webp`);
      let hasThumb = false;
      if (fs.existsSync(thumbPath)) {
        const destThumbPath = path.join(TRASH_PATH, `${trashedName}-thumb.webp`);
        fs.renameSync(thumbPath, destThumbPath);
        hasThumb = true;
      }

      db.trash[trashedName] = {
        originalPath: targetPath,
        originalFolder: folder || "root",
        originalName: name,
        trashedAt: new Date().toISOString(),
        size: fs.statSync(destPath).size,
        hasThumb
      };

      delete db.files[fileKey];
      writeDb(db);

      logEvent("FILE_SOFT_DELETE", { folder, name, trashedAs: trashedName });
      res.json({ success: true, message: "File moved to Trash", trashedName });
    }
  } else {
    res.status(404).json({ error: "File not found" });
  }
});

// 5. CREATE FOLDER
app.post("/create-folder", requireAuth, (req, res) => {
  const { folder } = req.body;
  if (!folder) return res.status(400).json({ error: "Folder name required" });

  const safeFolder = folder.replace(/[^a-zA-Z0-9.\-_/]/g, "");
  const targetDir = path.join(UPLOAD_PATH, safeFolder);

  if (!targetDir.startsWith(UPLOAD_PATH)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    logEvent("FOLDER_CREATE", { folder: safeFolder });
    res.json({ success: true, message: "Folder created" });
  } else {
    res.status(400).json({ error: "Folder already exists" });
  }
});

// 6. RENAME FILE/FOLDER
app.post("/rename", requireAuth, (req, res) => {
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) return res.status(400).json({ error: "oldPath and newPath required" });

  const resolvedUploadPath = path.resolve(UPLOAD_PATH);
  const absoluteOld = path.resolve(path.join(UPLOAD_PATH, oldPath));
  const absoluteNew = path.resolve(path.join(UPLOAD_PATH, newPath));

  if (!absoluteOld.startsWith(resolvedUploadPath) || !absoluteNew.startsWith(resolvedUploadPath)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  if (!fs.existsSync(absoluteOld)) {
    return res.status(404).json({ error: "Source not found" });
  }

  try {
    fs.renameSync(absoluteOld, absoluteNew);

    const db = readDb();
    const oldKey = oldPath.includes("/") ? oldPath : `root/${oldPath}`;
    const newKey = newPath.includes("/") ? newPath : `root/${newPath}`;

    if (db.files[oldKey]) {
      db.files[newKey] = db.files[oldKey];
      delete db.files[oldKey];
      writeDb(db);
    } else {
      writeDb(db); // Rebuild cache even if no meta entry
    }

    // Also rename thumbnail if it exists
    const oldFileName = path.basename(oldPath);
    const newFileName = path.basename(newPath);
    const oldThumb = path.join(THUMBNAIL_PATH, `${oldFileName}-thumb.webp`);
    const newThumb = path.join(THUMBNAIL_PATH, `${newFileName}-thumb.webp`);
    if (fs.existsSync(oldThumb)) {
      try { fs.renameSync(oldThumb, newThumb); } catch (e) { /* non-fatal */ }
    }

    logEvent("FILE_RENAME", { oldPath, newPath });
    res.json({ success: true, message: "Renamed successfully" });
  } catch (err) {
    console.error("Rename error:", err);
    res.status(500).json({ error: "Failed to rename file: " + err.message });
  }
});

// 7. MOVE FILE
app.post("/move-file", requireAuth, (req, res) => {
  const { file, sourceFolder, destinationFolder } = req.body;
  if (!file || destinationFolder === undefined) return res.status(400).json({ error: "Missing parameters" });

  const srcPath = sourceFolder && sourceFolder !== "root"
    ? path.join(UPLOAD_PATH, sourceFolder, file)
    : path.join(UPLOAD_PATH, file);

  const destPath = destinationFolder && destinationFolder !== "root"
    ? path.join(UPLOAD_PATH, destinationFolder, file)
    : path.join(UPLOAD_PATH, file);

  if (!srcPath.startsWith(UPLOAD_PATH) || !destPath.startsWith(UPLOAD_PATH)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  if (!fs.existsSync(path.dirname(destPath))) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
  }

  if (fs.existsSync(srcPath)) {
    fs.renameSync(srcPath, destPath);

    const db = readDb();
    const oldKey = `${sourceFolder || "root"}/${file}`;
    const newKey = `${destinationFolder || "root"}/${file}`;
    if (db.files[oldKey]) {
      db.files[newKey] = db.files[oldKey];
      delete db.files[oldKey];
      writeDb(db);
    }

    logEvent("FILE_MOVE", { file, sourceFolder, destinationFolder });
    res.json({ success: true, message: "File moved successfully" });
  } else {
    res.status(404).json({ error: "Source file not found" });
  }
});

// 7.5 MOVE FOLDER
app.post("/admin/move-folder", requireAuth, (req, res) => {
  const { sourceFolder, destinationFolder } = req.body;
  if (!sourceFolder || destinationFolder === undefined) return res.status(400).json({ error: "Missing parameters" });
  if (sourceFolder === destinationFolder || sourceFolder === "root") return res.status(400).json({ error: "Invalid move" });

  const srcPath = path.join(UPLOAD_PATH, sourceFolder);
  const destName = path.basename(sourceFolder);
  const destPath = destinationFolder === "root" || !destinationFolder
    ? path.join(UPLOAD_PATH, destName)
    : path.join(UPLOAD_PATH, destinationFolder, destName);

  if (!srcPath.startsWith(UPLOAD_PATH) || !destPath.startsWith(UPLOAD_PATH)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  if (fs.existsSync(destPath)) {
    return res.status(400).json({ error: "Destination folder already exists" });
  }

  if (fs.existsSync(srcPath)) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.renameSync(srcPath, destPath);

    const db = readDb();
    const oldPrefix = `${sourceFolder}/`;
    const newPrefix = destinationFolder === "root" || !destinationFolder ? `${destName}/` : `${destinationFolder}/${destName}/`;

    const newFiles = {};
    for (const key in db.files) {
      if (key.startsWith(oldPrefix)) {
        const rest = key.substring(oldPrefix.length);
        newFiles[`${newPrefix}${rest}`] = {
          ...db.files[key],
          folder: destinationFolder === "root" || !destinationFolder ? destName : `${destinationFolder}/${destName}`
        };
      } else {
        newFiles[key] = db.files[key];
      }
    }
    db.files = newFiles;
    writeDb(db);

    logEvent("FOLDER_MOVE", { sourceFolder, destinationFolder });
    res.json({ success: true, message: "Folder moved successfully" });
  } else {
    res.status(404).json({ error: "Source folder not found" });
  }
});

// 8. PRIVACY TOGGLE
app.post("/admin/toggle-privacy", requireAuth, (req, res) => {
  const { folder, name, isPublic } = req.body;
  if (!name || isPublic === undefined) return res.status(400).json({ error: "Missing parameter" });

  const db = readDb();
  const fileKey = `${folder || "root"}/${name}`;
  db.files[fileKey] = {
    ...(db.files[fileKey] || { downloads: 0 }),
    isPublic: !!isPublic
  };
  writeDb(db);

  logEvent("PRIVACY_TOGGLE", { folder, name, isPublic });
  res.json({ success: true, message: `Privacy updated to ${isPublic ? "Public" : "Private"}` });
});

// 8b. TOGGLE PIN
app.post("/admin/toggle-pin", requireAuth, (req, res) => {
  const { folder, name } = req.body;
  if (!name) return res.status(400).json({ error: "Missing file name" });

  const db = readDb();
  const fileKey = `${folder || "root"}/${name}`;
  const current = db.files[fileKey] || {};
  db.files[fileKey] = { ...current, pinned: !current.pinned };
  writeDb(db);

  logEvent("TOGGLE_PIN", { folder, name, pinned: db.files[fileKey].pinned });
  res.json({ success: true, pinned: db.files[fileKey].pinned });
});

// 8c. SET EXPIRY
app.post("/admin/set-expiry", requireAuth, (req, res) => {
  const { folder, name, expiresAt } = req.body;
  if (!name) return res.status(400).json({ error: "Missing file name" });

  const db = readDb();
  const fileKey = `${folder || "root"}/${name}`;
  const current = db.files[fileKey] || {};
  
  if (expiresAt) {
    db.files[fileKey] = { ...current, expiresAt };
  } else {
    const { expiresAt: _, ...rest } = current;
    db.files[fileKey] = rest;
  }
  
  writeDb(db);
  logEvent("SET_EXPIRY", { folder, name, expiresAt });
  res.json({ success: true, expiresAt: db.files[fileKey]?.expiresAt || null });
});


// 9. CREATE EXPIRING SHARE
app.post("/admin/create-share", requireAuth, requirePermission("canShare"), (req, res) => {
  const { folder, name, durationMs, password } = req.body;
  if (!name) return res.status(400).json({ error: "File name required" });

  const shareId = crypto.randomBytes(8).toString("hex");
  const expiresAt = durationMs ? Date.now() + durationMs : null;

  const db = readDb();
  db.shares[shareId] = {
    folder: folder || "root",
    name,
    expiresAt,
    password: password ? crypto.createHash("sha256").update(password).digest("hex") : null
  };
  writeDb(db);

  logEvent("SHARE_LINK_CREATE", { folder, name, shareId });
  sendSystemAlertEmail("Share Link Created", `A share link was created for <strong>${name}</strong>.`, "🔗", "onShare");
  res.json({ success: true, shareUrl: `${BASE_URL}/share/${shareId}` });
});

// 9b. SEND SHARE VIA EMAIL
app.post("/admin/share/email", requireAuth, async (req, res) => {
  const { folder, name, email, url, attachFile } = req.body;
  if (!name || !email || !url) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!transporter) {
    return res.status(500).json({ error: "SMTP is not configured on the server." });
  }

  try {
    const absoluteUrl = url.startsWith("http") ? url : `${BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
    const displayFilename = name.length > 50 ? name.substring(0, 47) + "..." : name;

    const mailOptions = {
      from: `"Storage Admin" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `📁 A file has been shared with you: ${displayFilename}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px; background-color: #f8fafc; color: #334155; text-align: center;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 16px; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05); border: 1px solid #e2e8f0;">
            <div style="background-color: #dbeafe; height: 72px; width: 72px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px auto;">
              <span style="font-size: 36px;">📁</span>
            </div>
            <h2 style="color: #3b82f6; font-weight: 800; font-size: 26px; margin-bottom: 12px; margin-top: 0;">File Shared With You</h2>
            <p style="color: #64748b; font-size: 16px; margin-bottom: 32px; line-height: 1.6;">Someone has securely shared a file with you via Storage Admin.</p>
            
            <div style="background-color: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 12px; padding: 20px 24px; margin-bottom: 36px; display: inline-block; max-width: 100%; box-sizing: border-box;">
              <p style="margin: 0; font-size: 18px; font-weight: 600; color: #0f172a; word-break: break-word; overflow-wrap: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis;">${name}</p>
            </div>
            
            <div>
              <a href="${absoluteUrl}" style="display: inline-block; background-color: #3b82f6; color: #ffffff; font-weight: 600; font-size: 16px; text-decoration: none; padding: 16px 32px; border-radius: 8px; transition: background-color 0.2s; box-shadow: 0 4px 6px -1px rgba(59, 130, 246, 0.3);">
                View / Download File
              </a>
            </div>
            
            <div style="margin-top: 40px; padding-top: 24px; border-top: 1px solid #e2e8f0;">
              <p style="color: #94a3b8; font-size: 13px; line-height: 1.5; margin: 0;">If the button doesn't work, copy and paste this link into your browser:<br/><a href="${absoluteUrl}" style="color: #3b82f6; text-decoration: none; word-break: break-all; margin-top: 8px; display: inline-block;">${absoluteUrl}</a></p>
            </div>
          </div>
        </div>
      `,
    };

    if (attachFile) {
      const filePath = folder === "root"
        ? path.join(UPLOAD_PATH, name)
        : path.join(UPLOAD_PATH, folder, name);
      
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        // Limit to 25MB (26214400 bytes) since SMTP servers commonly reject larger attachments
        if (stat.size <= 26214400) {
          mailOptions.attachments = [{
            filename: name,
            path: filePath
          }];
        }
      }
    }

    await transporter.sendMail(mailOptions);
    logEvent("SHARE_EMAIL_SENT", { folder, name, email });
    res.json({ success: true });
  } catch (err) {
    console.error("Failed to send share email:", err);
    res.status(500).json({ error: "Failed to send email" });
  }
});

// 9c. SEND BULK SHARE VIA EMAIL
app.post("/admin/bulk-share-email", requireAuth, async (req, res) => {
  const { files, email, durationMs, password } = req.body; // files: [{ folder, name }]
  
  if (!Array.isArray(files) || files.length === 0 || !email) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!transporter) {
    return res.status(500).json({ error: "SMTP is not configured on the server." });
  }

  const db = readDb();
  const fileLinks = [];

  // Generate a share link for each file
  files.forEach(({ folder, name }) => {
    const shareId = crypto.randomUUID();
    db.shares[shareId] = {
      folder,
      name,
      expiresAt: durationMs ? Date.now() + durationMs : null,
      password: password ? crypto.createHash("sha256").update(password).digest("hex") : null,
      createdAt: Date.now()
    };
    
    fileLinks.push({
      name,
      url: `${BASE_URL}/share/${shareId}`
    });
    
    logEvent("SHARE_CREATED", { folder, name, shareId });
  });

  writeDb(db);

  try {
    const fileListHtml = fileLinks.map(f => `
      <div style="background-color: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between;">
        <p style="margin: 0; font-size: 16px; font-weight: 600; color: #0f172a; flex: 1; word-break: break-word; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${f.name}</p>
        <a href="${f.url}" style="display: inline-block; background-color: #3b82f6; color: #ffffff; font-weight: 600; font-size: 14px; text-decoration: none; padding: 10px 20px; border-radius: 8px; margin-left: 16px; white-space: nowrap; transition: background-color 0.2s;">View / Download</a>
      </div>
    `).join("");

    const mailOptions = {
      from: `"Storage Admin" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `📁 ${files.length} file${files.length > 1 ? 's have' : ' has'} been shared with you`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px; background-color: #f8fafc; color: #334155; text-align: center;">
          <div style="max-width: 650px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 16px; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05); border: 1px solid #e2e8f0; text-align: left;">
            <div style="background-color: #dbeafe; height: 72px; width: 72px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px auto;">
              <span style="font-size: 36px;">📁</span>
            </div>
            <h2 style="color: #3b82f6; font-weight: 800; font-size: 26px; margin-bottom: 12px; margin-top: 0; text-align: center;">Files Shared With You</h2>
            <p style="color: #64748b; font-size: 16px; margin-bottom: 32px; line-height: 1.6; text-align: center;">Someone has securely shared ${files.length} file${files.length > 1 ? 's' : ''} with you via Storage Admin.</p>
            
            ${fileListHtml}
            
            <div style="margin-top: 40px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
              <p style="color: #94a3b8; font-size: 13px; line-height: 1.5; margin: 0;">These links ${durationMs ? 'will expire' : 'are permanent'}. Do not share them with anyone else.</p>
            </div>
          </div>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    logEvent("BULK_SHARE_EMAIL_SENT", { count: files.length, email });
    res.json({ success: true, count: files.length });
  } catch (err) {
    console.error("Failed to send bulk share email:", err);
    res.status(500).json({ error: "Failed to send email" });
  }
});

// 10. GET AUDIT LOGS
app.get("/admin/logs", requireAuth, (req, res) => {
  const db = readDb();
  res.json(db.logs);
});

// =====================
// DEVELOPER & API ENDPOINTS
// =====================
app.get("/admin/developer", requireAuth, (req, res) => {
  res.json({ apiKey: API_KEY, baseUrl: BASE_URL });
});

// =====================
// FUTURE-READY USER MANAGEMENT ENDPOINTS
// =====================
app.get("/admin/users", requireAuth, (req, res) => {
  const db = readDb();
  const safeUsers = Object.entries(db.users).map(([username, info]) => ({
    username,
    apiKey: info.apiKey.substring(0, 4) + "..." // Obfuscate keys
  }));
  res.json(safeUsers);
});

app.post("/admin/users", requireAuth, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "Username required" });

  const db = readDb();
  const newApiKey = "key_" + crypto.randomBytes(16).toString("hex");

  db.users[username] = {
    apiKey: newApiKey,
    createdAt: new Date().toISOString()
  };
  writeDb(db);

  logEvent("USER_CREATED", { username });
  res.json({ success: true, username, apiKey: newApiKey });
});

app.delete("/admin/users/:username", requireAuth, (req, res) => {
  const { username } = req.params;
  const db = readDb();

  if (db.users[username]) {
    delete db.users[username];
    writeDb(db);
    logEvent("USER_DELETED", { username });
    res.json({ success: true, message: `User ${username} deleted.` });
  } else {
    res.status(404).json({ error: "User not found" });
  }
});

// =====================
// PUBLIC SHARE RESOLUTION ENDPOINT
// =====================
app.get("/share/:shareId", (req, res) => {
  const { shareId } = req.params;
  const db = readDb();
  const share = db.shares[shareId];

  const renderSharePage = (title, message, isPasswordForm = false, isError = false) => `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
      <style>
        :root {
          --bg-color: #0f172a;
          --card-bg: rgba(30, 41, 59, 0.7);
          --card-border: rgba(255, 255, 255, 0.1);
          --primary: #6366f1;
          --primary-hover: #4f46e5;
          --text-main: #f8fafc;
          --text-muted: #94a3b8;
        }
        body {
          font-family: 'Inter', -apple-system, sans-serif;
          background: var(--bg-color);
          background-image: radial-gradient(circle at top right, rgba(99, 102, 241, 0.15), transparent 40%), radial-gradient(circle at bottom left, rgba(236, 72, 153, 0.1), transparent 40%);
          color: var(--text-main);
          display: flex; align-items: center; justify-content: center;
          min-height: 100vh; margin: 0;
        }
        .container {
          width: 100%; max-width: 400px; padding: 20px;
          animation: fadeIn 0.4s ease-out forwards;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .card {
          background: var(--card-bg);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid var(--card-border);
          border-radius: 24px; padding: 40px; text-align: center;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          position: relative; overflow: hidden;
        }
        .card::before {
          content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
          background: linear-gradient(90deg, #6366f1, #ec4899);
        }
        .icon-wrapper {
          width: 64px; height: 64px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center; margin: 0 auto 24px;
          background: ${isError ? 'rgba(239, 68, 68, 0.1)' : 'rgba(99, 102, 241, 0.1)'};
          border: 1px solid ${isError ? 'rgba(239, 68, 68, 0.2)' : 'rgba(99, 102, 241, 0.2)'};
          color: ${isError ? '#ef4444' : '#818cf8'};
        }
        .icon-wrapper svg { width: 32px; height: 32px; }
        h3 { font-size: 24px; font-weight: 700; margin: 0 0 12px; letter-spacing: -0.025em; }
        p { color: var(--text-muted); font-size: 15px; line-height: 1.5; margin: 0 0 32px; }
        form { display: flex; flex-direction: column; gap: 16px; }
        input {
          width: 100%; background: rgba(15, 23, 42, 0.6); border: 1px solid ${isError ? 'rgba(239, 68, 68, 0.4)' : 'rgba(255, 255, 255, 0.1)'};
          color: white; padding: 14px 16px; border-radius: 12px; font-size: 15px; font-family: inherit; box-sizing: border-box; transition: all 0.2s;
        }
        input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2); }
        button {
          background: var(--primary); color: white; border: none; padding: 14px 24px; border-radius: 12px;
          font-size: 15px; font-weight: 600; font-family: inherit; cursor: pointer; transition: all 0.2s;
          box-shadow: 0 4px 6px -1px rgba(99, 102, 241, 0.4);
        }
        button:hover { background: var(--primary-hover); transform: translateY(-1px); box-shadow: 0 6px 8px -1px rgba(99, 102, 241, 0.5); }
        .error-text { color: #ef4444; font-size: 13px; margin-top: -8px; margin-bottom: 0px; font-weight: 500; text-align: left; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="card">
          <div class="icon-wrapper">
            ${isError && !isPasswordForm 
              ? `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`
              : `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>`}
          </div>
          <h3>${title}</h3>
          <p>${message}</p>
          ${isPasswordForm ? `
            <form method="GET">
              <input type="password" name="pass" placeholder="Enter password" required autofocus />
              ${isError ? `<div class="error-text">Incorrect password. Please try again.</div>` : ''}
              <button type="submit">Unlock File</button>
            </form>
          ` : ''}
        </div>
      </div>
    </body>
    </html>
  `;

  if (!share) {
    return res.status(404).send(renderSharePage("Link Unavailable", "This share link is invalid or no longer exists.", false, true));
  }

  if (share.expiresAt && Date.now() > share.expiresAt) {
    delete db.shares[shareId];
    writeDb(db);
    return res.status(410).send(renderSharePage("Link Expired", "This share link has expired and is no longer accessible.", false, true));
  }

  if (share.password) {
    const providedPass = req.query.pass || req.headers["x-share-password"];
    if (!providedPass) {
      return res.status(401).send(renderSharePage("Protected Link", "This file is protected. Please enter the password to securely access its contents.", true, false));
    }

    const hashedProvided = crypto.createHash("sha256").update(providedPass).digest("hex");
    if (hashedProvided !== share.password) {
      return res.status(403).send(renderSharePage("Protected Link", "This file is protected. Please enter the password to securely access its contents.", true, true));
    }
  }

  const filePath = share.folder === "root"
    ? path.join(UPLOAD_PATH, share.name)
    : path.join(UPLOAD_PATH, share.folder, share.name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File no longer exists.");
  }

  logEvent("SHARE_LINK_USE", { shareId, file: share.name });
  res.sendFile(filePath, { acceptRanges: true });
});

// =====================
// EXPIRED SHARES CLEANUP TASK (Cron Simulation)
// =====================
setInterval(() => {
  const db = readDb();
  let changed = false;
  const now = Date.now();
  Object.entries(db.shares).forEach(([shareId, share]) => {
    if (share.expiresAt && now > share.expiresAt) {
      delete db.shares[shareId];
      changed = true;
    }
  });
  if (changed) {
    writeDb(db);
    console.log("🧹 Auto-cleanup: Removed expired public share links.");
  }
}, 60 * 60 * 1000); // Check once per hour

// =====================
// EMAIL & SHARE ENDPOINTS
// =====================

app.post("/admin/share/email", requireAuth, async (req, res) => {
  const { folder, name, email, url, attachFile } = req.body;
  
  if (!folder || !name || !email || !url) {
    return res.status(400).json({ error: "Missing required fields: folder, name, email, url" });
  }

  if (!transporter) {
    return res.status(503).json({ error: "Email server (SMTP) is not configured or disabled." });
  }

  const filePath = folder === "root" 
    ? path.join(UPLOAD_PATH, name) 
    : path.join(UPLOAD_PATH, folder, name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found on server." });
  }

  try {
    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: `Someone shared a file with you: ${name}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px; background-color: #f1f5f9; color: #334155; text-align: center;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
            <div style="background-color: #e0e7ff; height: 60px; width: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px auto;">
              <span style="font-size: 30px;">📁</span>
            </div>
            <h2 style="color: #4f46e5; font-weight: 800; font-size: 24px; margin-bottom: 10px; margin-top: 0;">A File Was Shared With You</h2>
            <p style="color: #64748b; font-size: 16px; margin-bottom: 30px; line-height: 1.5;">You've been granted access to download the following file:</p>
            
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; text-align: left; margin-bottom: 30px;">
              <p style="margin: 0; font-weight: 600; color: #0f172a; font-size: 16px;">${name}</p>
            </div>
            
            <a href="${url}" style="display: inline-block; background-color: #4f46e5; color: #ffffff; font-weight: 600; font-size: 16px; text-decoration: none; padding: 14px 28px; border-radius: 8px; transition: background-color 0.2s;">View & Download File</a>
          </div>
        </div>
      `
    };

    if (attachFile) {
      const stats = fs.statSync(filePath);
      const sizeMB = stats.size / (1024 * 1024);
      if (sizeMB <= 25) {
        mailOptions.attachments = [{ filename: name, path: filePath }];
      }
    }

    await transporter.sendMail(mailOptions);
    res.json({ success: true });
  } catch (err) {
    console.error("Email send error:", err);
    res.status(500).json({ error: "Failed to send email." });
  }
});

app.post("/admin/bulk-share-email", requireAuth, async (req, res) => {
  const { files, email, durationMs, password } = req.body;
  
  if (!Array.isArray(files) || files.length === 0 || !email) {
    return res.status(400).json({ error: "Missing required fields: files array and email" });
  }

  if (!transporter) {
    return res.status(503).json({ error: "Email server (SMTP) is not configured." });
  }

  const db = readDb();
  const fileLinks = [];
  
  let hashedPassword = null;
  if (password) {
    hashedPassword = crypto.createHash("sha256").update(password).digest("hex");
  }

  for (const f of files) {
    const filePath = f.folder === "root" 
      ? path.join(UPLOAD_PATH, f.name) 
      : path.join(UPLOAD_PATH, f.folder, f.name);

    if (fs.existsSync(filePath)) {
      const shareId = crypto.randomBytes(16).toString("hex");
      const expiresAt = durationMs ? Date.now() + durationMs : null;

      db.shares[shareId] = {
        folder: f.folder,
        name: f.name,
        createdAt: Date.now(),
        expiresAt,
        password: hashedPassword,
      };

      fileLinks.push({
        name: f.name,
        url: `${BASE_URL}/share/${shareId}`
      });
    }
  }

  if (fileLinks.length === 0) {
    return res.status(404).json({ error: "None of the specified files were found." });
  }

  writeDb(db);

  try {
    const listHtml = fileLinks.map(f => 
      `<li style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; list-style-type: none;">
        <p style="margin: 0 0 6px 0; font-weight: 600; color: #0f172a;">${f.name}</p>
        <a href="${f.url}" style="color: #4f46e5; text-decoration: none; font-size: 14px; font-weight: 500;">Download link &rarr;</a>
      </li>`
    ).join('');

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: `${fileLinks.length} files shared with you`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px; background-color: #f1f5f9; color: #334155; text-align: center;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
            <div style="background-color: #e0e7ff; height: 60px; width: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px auto;">
              <span style="font-size: 30px;">📚</span>
            </div>
            <h2 style="color: #4f46e5; font-weight: 800; font-size: 24px; margin-bottom: 10px; margin-top: 0;">Files Shared With You</h2>
            <p style="color: #64748b; font-size: 16px; margin-bottom: 30px; line-height: 1.5;">You've been granted access to download ${fileLinks.length} files:</p>
            
            <ul style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; text-align: left; margin: 0; padding-left: 20px;">
              ${listHtml}
            </ul>
          </div>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    res.json({ success: true, count: fileLinks.length });
  } catch (err) {
    console.error("Bulk email send error:", err);
    res.status(500).json({ error: "Failed to send email." });
  }
});

// =====================
// ADDITIONAL ENDPOINTS
// =====================

// 11. BULK DELETE FILES
app.post("/admin/bulk-delete", requireAuth, (req, res) => {
  const { files } = req.body; // [{ folder, name }]
  if (!Array.isArray(files) || files.length === 0)
    return res.status(400).json({ error: "Files array required" });

  const db = readDb();
  let deleted = 0;
  const errors = [];

  files.forEach(({ folder, name }) => {
    const targetPath = folder && folder !== "root"
      ? path.join(UPLOAD_PATH, folder, name)
      : path.join(UPLOAD_PATH, name);

    if (!targetPath.startsWith(UPLOAD_PATH)) return errors.push(name);

    try {
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      const thumbPath = path.join(THUMBNAIL_PATH, `${name}-thumb.webp`);
      if (fs.existsSync(thumbPath)) {
        fs.unlinkSync(thumbPath);
      }
      if (db.files[`${folder || "root"}/${name}`]) {
        delete db.files[`${folder || "root"}/${name}`];
        deleted++;
      }
    } catch (e) {
      errors.push(name);
    }
  });

  writeDb(db);
  logEvent("BULK_DELETE", { count: deleted });
  res.json({ success: true, deleted, errors });
});

// BULK TOGGLE PIN
app.post("/admin/bulk-pin", requireAuth, (req, res) => {
  const { files, isPinned } = req.body;
  if (!Array.isArray(files)) return res.status(400).json({ error: "Files array required" });
  const db = readDb();
  files.forEach(({ folder, name }) => {
    const key = `${folder || "root"}/${name}`;
    if (db.files[key]) db.files[key].isPinned = isPinned;
  });
  writeDb(db);
  logEvent("BULK_TOGGLE_PIN", { count: files.length, isPinned });
  res.json({ success: true });
});

// BULK TOGGLE PRIVACY
app.post("/admin/bulk-privacy", requireAuth, (req, res) => {
  const { files, isPublic } = req.body;
  if (!Array.isArray(files)) return res.status(400).json({ error: "Files array required" });
  const db = readDb();
  files.forEach(({ folder, name }) => {
    const key = `${folder || "root"}/${name}`;
    if (db.files[key]) db.files[key].isPublic = isPublic;
  });
  writeDb(db);
  logEvent("BULK_TOGGLE_PRIVACY", { count: files.length, isPublic });
  res.json({ success: true });
});

// BULK SET EXPIRY
app.post("/admin/bulk-expiry", requireAuth, (req, res) => {
  const { files, expiresAt } = req.body;
  if (!Array.isArray(files)) return res.status(400).json({ error: "Files array required" });
  const db = readDb();
  files.forEach(({ folder, name }) => {
    const key = `${folder || "root"}/${name}`;
    if (db.files[key]) db.files[key].expiresAt = expiresAt;
  });
  writeDb(db);
  logEvent("BULK_SET_EXPIRY", { count: files.length, expiresAt });
  res.json({ success: true });
});

// 12. BULK MOVE FILES
app.post("/admin/bulk-move", requireAuth, (req, res) => {
  const { files, destinationFolder } = req.body; // files: [{ folder, name }]
  if (!Array.isArray(files) || !destinationFolder)
    return res.status(400).json({ error: "Files array and destinationFolder required" });

  const db = readDb();
  const destDir = destinationFolder === "root" ? UPLOAD_PATH : path.join(UPLOAD_PATH, destinationFolder);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  let moved = 0;
  const errors = [];

  files.forEach(({ folder, name }) => {
    const srcPath = folder && folder !== "root"
      ? path.join(UPLOAD_PATH, folder, name)
      : path.join(UPLOAD_PATH, name);
    const destPath = path.join(destDir, name);

    if (!srcPath.startsWith(UPLOAD_PATH) || !destPath.startsWith(UPLOAD_PATH))
      return errors.push(name);

    try {
      if (fs.existsSync(srcPath)) {
        fs.renameSync(srcPath, destPath);
        const oldKey = `${folder || "root"}/${name}`;
        const newKey = `${destinationFolder}/${name}`;
        if (db.files[oldKey]) {
          db.files[newKey] = db.files[oldKey];
          delete db.files[oldKey];
        }
        moved++;
      }
    } catch (e) {
      errors.push(name);
    }
  });

  writeDb(db);
  logEvent("BULK_MOVE", { count: moved, destinationFolder });
  res.json({ success: true, moved, errors });
});

// 13. DELETE FOLDER (recursive)
app.delete("/admin/folder", requireAuth, (req, res) => {
  const { folder } = req.body;
  if (!folder || folder === "root") return res.status(400).json({ error: "Valid folder name required" });

  const targetDir = path.join(UPLOAD_PATH, folder);
  if (!targetDir.startsWith(UPLOAD_PATH)) return res.status(403).json({ error: "Invalid path" });
  if (!fs.existsSync(targetDir)) return res.status(404).json({ error: "Folder not found" });

  // Remove all db entries for this folder
  const db = readDb();
  Object.keys(db.files).forEach(key => {
    if (key.startsWith(`${folder}/`)) delete db.files[key];
  });

  fs.rmSync(targetDir, { recursive: true, force: true });
  writeDb(db);
  logEvent("FOLDER_DELETE", { folder });
  res.json({ success: true, message: `Folder "${folder}" deleted` });
});

// 14. RENAME FOLDER
app.post("/admin/rename-folder", requireAuth, (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: "oldName and newName required" });

  const safeNew = newName.replace(/[^a-zA-Z0-9.\-_]/g, "");
  const srcDir = path.join(UPLOAD_PATH, oldName);
  const destDir = path.join(UPLOAD_PATH, safeNew);

  if (!srcDir.startsWith(UPLOAD_PATH) || !destDir.startsWith(UPLOAD_PATH))
    return res.status(403).json({ error: "Invalid path" });
  if (!fs.existsSync(srcDir)) return res.status(404).json({ error: "Folder not found" });
  if (fs.existsSync(destDir)) return res.status(400).json({ error: "Destination folder already exists" });

  fs.renameSync(srcDir, destDir);

  // Update db keys
  const db = readDb();
  const updatedFiles = {};
  Object.entries(db.files).forEach(([key, val]) => {
    const newKey = key.startsWith(`${oldName}/`) ? key.replace(`${oldName}/`, `${safeNew}/`) : key;
    updatedFiles[newKey] = val;
  });
  db.files = updatedFiles;
  writeDb(db);

  logEvent("FOLDER_RENAME", { oldName, newName: safeNew });
  res.json({ success: true, message: `Folder renamed to "${safeNew}"` });
});

// 15. COPY FILE
app.post("/admin/copy-file", requireAuth, (req, res) => {
  const { file, sourceFolder, destinationFolder } = req.body;
  if (!file || !destinationFolder) return res.status(400).json({ error: "Missing parameters" });

  const srcPath = sourceFolder && sourceFolder !== "root"
    ? path.join(UPLOAD_PATH, sourceFolder, file)
    : path.join(UPLOAD_PATH, file);

  const destDir = destinationFolder === "root" ? UPLOAD_PATH : path.join(UPLOAD_PATH, destinationFolder);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const copyName = `${base}-copy${ext}`;
  const destPath = path.join(destDir, copyName);

  if (!srcPath.startsWith(UPLOAD_PATH) || !destPath.startsWith(UPLOAD_PATH))
    return res.status(403).json({ error: "Invalid path" });
  if (!fs.existsSync(srcPath)) return res.status(404).json({ error: "Source file not found" });

  fs.copyFileSync(srcPath, destPath);

  const db = readDb();
  const srcKey = `${sourceFolder || "root"}/${file}`;
  db.files[`${destinationFolder}/${copyName}`] = { ...(db.files[srcKey] || {}), downloads: 0 };
  writeDb(db);

  logEvent("FILE_COPY", { file, sourceFolder, destinationFolder });
  res.json({ success: true, newName: copyName, folder: destinationFolder });
});

// 15a. GET FILE CONTENT
app.get("/admin/file-content", requireAuth, (req, res) => {
  const { folder, name } = req.query;
  if (!name) return res.status(400).json({ error: "Missing parameters" });

  const filePath = folder && folder !== "root"
    ? path.join(UPLOAD_PATH, folder, name)
    : path.join(UPLOAD_PATH, name);

  if (!filePath.startsWith(UPLOAD_PATH)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    res.send(content);
  } catch (err) {
    console.error("Read file error:", err);
    res.status(500).json({ error: "Failed to read file" });
  }
});

// 15b. SAVE FILE CONTENT
app.post("/admin/save-file", requireAuth, (req, res) => {
  const { folder, name, content } = req.body;
  if (!name || content === undefined) return res.status(400).json({ error: "Missing parameters" });

  const filePath = folder && folder !== "root"
    ? path.join(UPLOAD_PATH, folder, name)
    : path.join(UPLOAD_PATH, name);

  if (!filePath.startsWith(UPLOAD_PATH)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    fs.writeFileSync(filePath, content, "utf8");
    const db = readDb();
    // writeDb triggers rebuildFileCache so file sizes get updated automatically
    writeDb(db);
    logEvent("FILE_EDIT", { folder, name });
    res.json({ success: true });
  } catch (err) {
    console.error("Save file error:", err);
    res.status(500).json({ error: "Failed to save file" });
  }
});

// 15c. RUN PYTHON FILE (server-side execution)
app.post("/admin/run-python", requireAuth, (req, res) => {
  const { folder, name } = req.body;
  if (!name) return res.status(400).json({ error: "Missing parameters" });

  const filePath = folder && folder !== "root"
    ? path.join(UPLOAD_PATH, folder, name)
    : path.join(UPLOAD_PATH, name);

  if (!filePath.startsWith(UPLOAD_PATH))
    return res.status(403).json({ error: "Invalid path" });
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "File not found" });

  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  let stdout = "";
  let stderr = "";
  let finished = false;

  const proc = spawn(pythonCmd, [filePath], {
    env: { ...process.env, PYGAME_HIDE_SUPPORT_PROMPT: "1" },
    timeout: 15000
  });

  proc.stdout.on("data", (data) => { stdout += data.toString(); });
  proc.stderr.on("data", (data) => { stderr += data.toString(); });

  const finish = (exitCode) => {
    if (finished) return;
    finished = true;
    logEvent("PYTHON_RUN", { folder, name, exitCode });
    res.json({ output: stdout, error: stderr, exitCode });
  };

  proc.on("close", finish);
  proc.on("error", (err) => {
    if (finished) return;
    finished = true;
    if (err.code === "ENOENT") {
      res.status(500).json({ error: "Python is not installed on the server." });
    } else {
      res.status(500).json({ error: err.message });
    }
  });

  // Hard timeout
  setTimeout(() => {
    if (!finished) {
      proc.kill("SIGKILL");
      finish(-1);
    }
  }, 15000);
});

// 16. SEARCH FILES
app.get("/admin/search", requireAuth, (req, res) => {
  const { q = "", type = "", folder = "" } = req.query;
  let files = fileCache;

  if (q) files = files.filter(f => f.name.toLowerCase().includes(q.toLowerCase()));
  if (type) files = files.filter(f => f.type === type);
  if (folder) files = files.filter(f => f.folder === folder);

  res.json(files.slice(0, 200));
});

// 17. GET FILES IN A SPECIFIC FOLDER
app.get("/admin/folder/:name", requireAuth, (req, res) => {
  const folderName = req.params.name;
  const folderPath = folderName === "root" ? UPLOAD_PATH : path.join(UPLOAD_PATH, folderName);

  if (!folderPath.startsWith(UPLOAD_PATH)) return res.status(403).json({ error: "Invalid path" });
  if (!fs.existsSync(folderPath)) return res.status(404).json({ error: "Folder not found" });

  const files = fileCache.filter(f => f.folder === folderName);
  res.json(files);
});

// 18. UPDATE FILE METADATA (tags / notes)
app.post("/admin/file-meta", requireAuth, (req, res) => {
  const { folder, name, tags, note } = req.body;
  if (!name) return res.status(400).json({ error: "File name required" });

  const db = readDb();
  const fileKey = `${folder || "root"}/${name}`;
  db.files[fileKey] = {
    ...(db.files[fileKey] || { isPublic: true, downloads: 0 }),
    tags: tags ?? db.files[fileKey]?.tags ?? [],
    note: note ?? db.files[fileKey]?.note ?? ""
  };
  writeDb(db);

  logEvent("FILE_META_UPDATE", { folder, name, tags, note });
  res.json({ success: true });
});

// 19. STORAGE CLEANUP — remove orphaned db.json entries
app.post("/admin/cleanup", requireAuth, (req, res) => {
  const db = readDb();
  let removed = 0;

  Object.keys(db.files).forEach(key => {
    const [folder, ...nameParts] = key.split("/");
    const name = nameParts.join("/");
    const filePath = folder === "root"
      ? path.join(UPLOAD_PATH, name)
      : path.join(UPLOAD_PATH, folder, name);

    if (!fs.existsSync(filePath)) {
      delete db.files[key];
      removed++;
    }
  });

  writeDb(db);
  logEvent("STORAGE_CLEANUP", { orphansRemoved: removed });
  res.json({ success: true, orphansRemoved: removed });
});

// 20. RECENT FILES (last N uploaded, across all folders)
app.get("/admin/recent", requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  res.json(fileCache.slice(0, limit));
});

// 21. SERVER DISK INFO
app.get("/admin/disk-info", requireAuth, (req, res) => {
  try {
    const files = fileCache;
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    const typeBreakdown = files.reduce((acc, f) => {
      acc[f.type] = (acc[f.type] || 0) + f.size;
      return acc;
    }, {});
    const folderBreakdown = files.reduce((acc, f) => {
      if (!acc[f.folder]) acc[f.folder] = { count: 0, bytes: 0 };
      acc[f.folder].count++;
      acc[f.folder].bytes += f.size;
      return acc;
    }, {});
    res.json({
      totalBytes,
      totalMB: (totalBytes / 1024 / 1024).toFixed(2),
      totalFiles: files.length,
      typeBreakdown,
      folderBreakdown,
      uploadPath: UPLOAD_PATH
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 22. CLEAR AUDIT LOGS
app.delete("/admin/logs", requireAuth, (req, res) => {
  const db = readDb();
  db.logs = [];
  writeDb(db);
  res.json({ success: true, message: "Logs cleared" });
});

// 23. GET TRASHED FILES
app.get("/admin/trash", requireAuth, (req, res) => {
  const db = readDb();
  const trashItems = Object.entries(db.trash).map(([trashedName, info]) => ({
    trashedName,
    ...info
  }));
  res.json(trashItems);
});

// 24. RESTORE FILE FROM TRASH
app.post("/admin/trash/restore", requireAuth, (req, res) => {
  const { trashedName } = req.body;
  if (!trashedName) return res.status(400).json({ error: "trashedName required" });

  const db = readDb();
  const info = db.trash[trashedName];
  if (!info) return res.status(404).json({ error: "File not found in trash" });

  const srcPath = path.join(TRASH_PATH, trashedName);
  const destPath = info.originalPath;

  if (!fs.existsSync(srcPath)) {
    delete db.trash[trashedName];
    writeDb(db);
    return res.status(404).json({ error: "Physical file missing in trash" });
  }

  // Ensure target folder exists
  const targetDir = path.dirname(destPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Restore file
  fs.renameSync(srcPath, destPath);

  // Restore thumbnail if it existed
  if (info.hasThumb) {
    const thumbName = `${info.originalName}-thumb.webp`;
    const srcThumbPath = path.join(TRASH_PATH, `${trashedName}-thumb.webp`);
    const destThumbPath = path.join(THUMBNAIL_PATH, thumbName);
    if (fs.existsSync(srcThumbPath)) {
      fs.renameSync(srcThumbPath, destThumbPath);
    }
  }

  // Re-register file in active db.files
  const fileKey = `${info.originalFolder}/${info.originalName}`;
  db.files[fileKey] = {
    isPublic: true,
    downloads: 0,
    pinned: false,
    tags: [],
    note: "",
    expiresAt: null
  };

  delete db.trash[trashedName];
  writeDb(db);

  logEvent("FILE_RESTORE", { folder: info.originalFolder, name: info.originalName });
  res.json({ success: true, message: "File restored successfully" });
});

// 25. EMPTY TRASH
app.delete("/admin/trash/empty", requireAuth, (req, res) => {
  const db = readDb();
  let deletedCount = 0;

  Object.keys(db.trash).forEach((trashedName) => {
    const filePath = path.join(TRASH_PATH, trashedName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    const thumbPath = path.join(TRASH_PATH, `${trashedName}-thumb.webp`);
    if (fs.existsSync(thumbPath)) {
      fs.unlinkSync(thumbPath);
    }

    deletedCount++;
  });

  db.trash = {};
  writeDb(db);

  logEvent("TRASH_EMPTY", { count: deletedCount });
  res.json({ success: true, message: `Trash cleared. Deleted ${deletedCount} files.` });
});

// 26. TOGGLE PIN/FAVORITE
app.post("/admin/toggle-pin", requireAuth, (req, res) => {
  const { folder, name } = req.body;
  if (!name) return res.status(400).json({ error: "File name required" });

  const db = readDb();
  const fileKey = `${folder || "root"}/${name}`;
  if (!db.files[fileKey]) {
    db.files[fileKey] = { isPublic: true, downloads: 0, pinned: false, tags: [], note: "", expiresAt: null };
  }

  const isPinned = !db.files[fileKey].pinned;
  db.files[fileKey].pinned = isPinned;
  writeDb(db);

  logEvent("FILE_PIN_TOGGLE", { folder, name, pinned: isPinned });
  res.json({ success: true, pinned: isPinned });
});

// 27. UPDATE FOLDER METADATA (Custom color, icon, note)
app.post("/admin/folder-meta", requireAuth, (req, res) => {
  const { folder, color, icon, note } = req.body;
  if (!folder || folder === "root") return res.status(400).json({ error: "Valid folder name required" });

  const db = readDb();
  db.folders[folder] = {
    ...(db.folders[folder] || {}),
    color: color ?? db.folders[folder]?.color ?? "",
    icon: icon ?? db.folders[folder]?.icon ?? "",
    note: note ?? db.folders[folder]?.note ?? ""
  };
  writeDb(db);

  logEvent("FOLDER_META_UPDATE", { folder, color, icon, note });
  res.json({ success: true });
});

// 28. SET FILE EXPIRATION
app.post("/admin/set-expiry", requireAuth, (req, res) => {
  const { folder, name, expiresAt } = req.body; // expiresAt is ISO string or null
  if (!name) return res.status(400).json({ error: "File name required" });

  const db = readDb();
  const fileKey = `${folder || "root"}/${name}`;
  if (!db.files[fileKey]) {
    db.files[fileKey] = { isPublic: true, downloads: 0, pinned: false, tags: [], note: "", expiresAt: null };
  }

  db.files[fileKey].expiresAt = expiresAt ? new Date(expiresAt).toISOString() : null;
  writeDb(db);

  logEvent("FILE_EXPIRY_SET", { folder, name, expiresAt });
  res.json({ success: true, expiresAt: db.files[fileKey].expiresAt });
});

// 29. WEBHOOK CONFIGURATION
app.post("/admin/webhook-config", requireAuth, (req, res) => {
  const { webhookUrl } = req.body;

  const db = readDb();
  db.webhookUrl = webhookUrl || "";
  writeDb(db);

  logEvent("WEBHOOK_CONFIG_UPDATE", { webhookUrl: db.webhookUrl });
  res.json({ success: true, webhookUrl: db.webhookUrl });
});

app.post("/admin/settings/discord-webhook", requireAuth, (req, res) => {
  const { discordWebhookUrl } = req.body;

  const db = readDb();
  if (!db.settings) db.settings = {};
  db.settings.discordWebhookUrl = discordWebhookUrl || "";
  writeDb(db);

  logEvent("DISCORD_WEBHOOK_UPDATE", { discordWebhookUrl: db.settings.discordWebhookUrl });
  res.json({ success: true, discordWebhookUrl: db.settings.discordWebhookUrl });
});

// 30. GET WEBHOOK CONFIG
app.get("/admin/webhook-config", requireAuth, (req, res) => {
  const db = readDb();
  res.json({ webhookUrl: db.webhookUrl || "" });
});

// 31. FILE INTEGRITY VERIFICATION
app.get("/admin/file-integrity", requireAuth, (req, res) => {
  const { folder, name } = req.query;
  if (!name) return res.status(400).json({ error: "File name required" });

  const filePath = folder && folder !== "root"
    ? path.join(UPLOAD_PATH, folder, name)
    : path.join(UPLOAD_PATH, name);

  if (!filePath.startsWith(UPLOAD_PATH) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Physical file not found" });
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const calculatedHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

    const db = readDb();
    const fileKey = `${folder || "root"}/${name}`;
    const storedHash = db.files[fileKey]?.hash;

    // Cache computed hash if not already cached
    if (db.files[fileKey] && !storedHash) {
      db.files[fileKey].hash = calculatedHash;
      writeDb(db);
    }

    const intact = !storedHash || storedHash === calculatedHash;

    res.json({
      intact,
      calculatedHash,
      storedHash: storedHash || calculatedHash,
      size: fileBuffer.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 32. ZIP MULTIPLE FILES & FOLDERS
app.post("/admin/zip", requireAuth, (req, res) => {
  const { files, zipName } = req.body; // files: [{ folder, name }]
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: "Files array required" });
  }

  const resolvedUploadPath = path.resolve(UPLOAD_PATH);
  const outputName = zipName ? `${zipName.replace(/[^a-zA-Z0-9.\-_]/g, "_")}.zip` : `archive-${Date.now()}.zip`;

  // --- Step 1: Validate which files actually exist (before touching the response) ---
  const validFiles = files.map(({ folder, name }) => {
    const filePath = path.resolve(
      folder && folder !== "root"
        ? path.join(UPLOAD_PATH, folder, name)
        : path.join(UPLOAD_PATH, name)
    );
    return { folder, name, filePath, exists: filePath.startsWith(resolvedUploadPath) && fs.existsSync(filePath) };
  }).filter(f => f.exists);

  if (validFiles.length === 0) {
    return res.status(404).json({ error: "No accessible files found to zip" });
  }

  // --- Step 2: Set up archive and pipe to response ---
  const archive = new archiver.ZipArchive({ zlib: { level: 9 } });

  archive.on("error", (err) => {
    console.error("Archive error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to create archive: " + err.message });
    }
  });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${outputName}"`);
  archive.pipe(res);

  // --- Step 3: Add files to archive ---
  const db = readDb();
  validFiles.forEach(({ folder, name, filePath }) => {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      archive.directory(filePath, name);
    } else {
      archive.file(filePath, { name });
    }

    // Record download analytics
    try {
      const dateStr = new Date().toISOString().split("T")[0];
      db.analytics.totalDownloads = (db.analytics.totalDownloads || 0) + stats.size;
      if (!db.analytics.dailyStats[dateStr]) {
        db.analytics.dailyStats[dateStr] = { uploads: 0, downloads: 0 };
      }
      db.analytics.dailyStats[dateStr].downloads = (db.analytics.dailyStats[dateStr].downloads || 0) + stats.size;
    } catch (e) { }
  });

  writeDb(db);
  logEvent("BULK_ZIP_DOWNLOAD", { fileCount: validFiles.length, outputName });

  // --- Step 4: Finalize ---
  archive.finalize();
});

// =====================
// EXPIRED FILES AUTO-CLEANUP TASK
// =====================
setInterval(() => {
  const db = readDb();
  let changed = false;
  const now = new Date();

  Object.entries(db.files).forEach(([fileKey, meta]) => {
    if (meta.expiresAt && new Date(meta.expiresAt) < now) {
      const [folder, ...nameParts] = fileKey.split("/");
      const name = nameParts.join("/");

      const filePath = folder === "root"
        ? path.join(UPLOAD_PATH, name)
        : path.join(UPLOAD_PATH, folder, name);

      if (fs.existsSync(filePath)) {
        try {
          // Move to Trash automatically instead of hard delete! This is super safe.
          const trashedName = `${Date.now()}-${name}`;
          const destPath = path.join(TRASH_PATH, trashedName);

          fs.renameSync(filePath, destPath);

          const thumbPath = path.join(THUMBNAIL_PATH, `${name}-thumb.webp`);
          let hasThumb = false;
          if (fs.existsSync(thumbPath)) {
            const destThumbPath = path.join(TRASH_PATH, `${trashedName}-thumb.webp`);
            fs.renameSync(thumbPath, destThumbPath);
            hasThumb = true;
          }

          db.trash[trashedName] = {
            originalPath: filePath,
            originalFolder: folder,
            originalName: name,
            trashedAt: new Date().toISOString(),
            size: fs.statSync(destPath).size,
            hasThumb
          };

          delete db.files[fileKey];
          changed = true;
          console.log(`🧹 Auto-expiry: Moved expired file ${fileKey} to Trash.`);
        } catch (e) {
          console.error(`Failed to auto-expire file ${fileKey}:`, e);
        }
      } else {
        delete db.files[fileKey];
        changed = true;
      }
    }
  });

  if (changed) {
    writeDb(db);
  }
}, 30 * 60 * 1000); // Run every 30 minutes

// 33. ANALYTICS DASHBOARD DATA
app.get("/admin/analytics", requireAuth, (req, res) => {
  try {
    const db = readDb();
    const files = fileCache;

    // File type distribution
    const typeStats = files.reduce((acc, f) => {
      acc[f.type] = (acc[f.type] || 0) + 1;
      return acc;
    }, {});

    // Size by type
    const sizeByType = files.reduce((acc, f) => {
      acc[f.type] = (acc[f.type] || 0) + f.size;
      return acc;
    }, {});

    // Public vs Private count
    const publicCount = files.filter(f => f.isPublic).length;
    const privateCount = files.length - publicCount;

    // Pinned count
    const pinnedCount = files.filter(f => f.pinned).length;

    // Files with expiry set
    const withExpiryCount = files.filter(f => f.expiresAt).length;

    // Top 5 folders by file count
    const folderCounts = {};
    files.forEach(f => {
      folderCounts[f.folder] = (folderCounts[f.folder] || 0) + 1;
    });
    const topFolders = Object.entries(folderCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([folder, count]) => ({ folder, count }));

    // Daily stats (last 30 days)
    const today = new Date();
    const last30Days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const dayData = db.analytics.dailyStats[dateStr] || { uploads: 0, downloads: 0 };
      last30Days.push({
        date: dateStr,
        uploads: dayData.uploads || 0,
        downloads: dayData.downloads || 0
      });
    }

    // Trash size
    const trashCount = Object.keys(db.trash).length;

    res.json({
      summary: {
        totalFiles: files.length,
        totalSizeBytes: files.reduce((s, f) => s + f.size, 0),
        publicCount,
        privateCount,
        pinnedCount,
        withExpiryCount,
        trashCount,
        totalUploadsBytes: db.analytics.totalUploads || 0,
        totalDownloadsBytes: db.analytics.totalDownloads || 0
      },
      typeStats,
      sizeByType,
      topFolders,
      last30Days
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 34. STORAGE TREND (hourly/daily bandwidth summary)
app.get("/admin/storage-trend", requireAuth, (req, res) => {
  try {
    const db = readDb();
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const today = new Date();
    const result = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const day = db.analytics.dailyStats[dateStr] || { uploads: 0, downloads: 0 };
      result.push({
        date: dateStr,
        uploadsMB: ((day.uploads || 0) / 1024 / 1024).toFixed(2),
        downloadsMB: ((day.downloads || 0) / 1024 / 1024).toFixed(2),
        uploadsBytes: day.uploads || 0,
        downloadsBytes: day.downloads || 0
      });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 35. FIND DUPLICATE FILES (by SHA256 hash)
app.get("/admin/duplicates", requireAuth, (req, res) => {
  try {
    const db = readDb();
    const hashMap = {};

    // Group file keys by their stored hash
    Object.entries(db.files).forEach(([key, meta]) => {
      if (meta.hash) {
        if (!hashMap[meta.hash]) hashMap[meta.hash] = [];
        hashMap[meta.hash].push(key);
      }
    });

    // Only return groups with 2+ files (actual duplicates)
    const duplicates = Object.entries(hashMap)
      .filter(([, keys]) => keys.length > 1)
      .map(([hash, keys]) => ({
        hash,
        count: keys.length,
        files: keys.map(key => {
          const [folder, ...nameParts] = key.split("/");
          return { folder, name: nameParts.join("/"), key };
        })
      }));

    res.json({ duplicateGroups: duplicates.length, duplicates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 36. SEARCH FILES BY TAGS
app.get("/admin/tag-search", requireAuth, (req, res) => {
  const { tags } = req.query; // comma-separated tags
  if (!tags) return res.status(400).json({ error: "tags query parameter required" });

  const searchTags = tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
  const results = fileCache.filter(f =>
    f.tags && f.tags.some(tag => searchTags.includes(tag.toLowerCase()))
  );
  res.json(results);
});

// 37. BULK TAG FILES
app.post("/admin/bulk-tag", requireAuth, (req, res) => {
  const { files, tags, mode } = req.body; // files: [{folder,name}], tags: string[], mode: 'add'|'replace'|'remove'
  if (!Array.isArray(files) || !Array.isArray(tags))
    return res.status(400).json({ error: "files array and tags array required" });

  const db = readDb();
  let updated = 0;

  files.forEach(({ folder, name }) => {
    const fileKey = `${folder || "root"}/${name}`;
    if (!db.files[fileKey]) {
      db.files[fileKey] = { isPublic: true, downloads: 0, pinned: false, tags: [], note: "", expiresAt: null };
    }
    const existing = db.files[fileKey].tags || [];
    if (mode === "replace") {
      db.files[fileKey].tags = tags;
    } else if (mode === "remove") {
      db.files[fileKey].tags = existing.filter(t => !tags.includes(t));
    } else {
      // 'add' (default): merge, no duplicates
      const merged = Array.from(new Set([...existing, ...tags]));
      db.files[fileKey].tags = merged;
    }
    updated++;
  });

  writeDb(db);
  logEvent("BULK_TAG", { count: updated, tags, mode: mode || "add" });
  res.json({ success: true, updated });
});

// 38. GET ALL PINNED FILES
app.get("/admin/pinned", requireAuth, (req, res) => {
  const pinned = fileCache.filter(f => f.pinned);
  res.json(pinned);
});

// 39. FORCE FILE CACHE REBUILD
app.post("/admin/cache-refresh", requireAuth, async (req, res) => {
  try {
    await rebuildFileCache();
    res.json({ success: true, cachedFiles: fileCache.length, message: "Cache rebuilt successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE FOLDER
app.post("/admin/create-folder", requireAuth, (req, res) => {
  try {
    const { folder } = req.body;
    if (!folder) return res.status(400).json({ error: "Folder name required" });
    
    const db = readDb();
    if (!db.folders) db.folders = {};
    if (!db.folders[folder]) {
      db.folders[folder] = { createdAt: new Date().toISOString() };
      writeDb(db);
    }
    
    // Also create physical directory
    const physicalPath = path.join(UPLOAD_PATH, folder);
    if (!fs.existsSync(physicalPath)) {
      fs.mkdirSync(physicalPath, { recursive: true });
    }
    
    res.json({ success: true, folder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET FILES FOR FOLDER
app.get("/admin/folder/:folder", requireAuth, (req, res) => {
  try {
    const { folder } = req.params;
    const files = fileCache.filter(f => f.folder === folder);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 40. FOLDER TREE (hierarchical folder structure with counts)
app.get("/admin/folder-tree", requireAuth, (req, res) => {
  try {
    const db = readDb();
    const files = fileCache;

    const tree = {};

    function addPathToTree(fullPath, isRoot = false) {
      const parts = isRoot ? ["root"] : fullPath.split("/");
      let node = tree;
      parts.forEach((part, idx) => {
        if (!node[part]) {
          node[part] = {
            name: part,
            path: parts.slice(0, idx + 1).join("/"),
            fileCount: 0,
            sizeBytes: 0,
            meta: db.folders && db.folders[parts.slice(0, idx + 1).join("/")] ? db.folders[parts.slice(0, idx + 1).join("/")] : {},
            children: {}
          };
        }
        node = node[part].children;
      });
    }

    // 1. Always ensure root exists
    addPathToTree("root", true);

    // 2. Add all physical folders
    function getDirectories(dirPath) {
      if (!fs.existsSync(dirPath)) return;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      entries.forEach((entry) => {
        if (entry.name === "db.json" || entry.name === "_thumbnails" || entry.name === "_trash") return;
        if (entry.isDirectory()) {
          const fullPath = path.join(dirPath, entry.name);
          const relativePath = path.relative(UPLOAD_PATH, fullPath).replace(/\\/g, "/");
          addPathToTree(relativePath);
          getDirectories(fullPath);
        }
      });
    }
    getDirectories(UPLOAD_PATH);

    // 3. Add files (populating sizes and counts)
    files.forEach(f => {
      const parts = f.folder === "root" ? ["root"] : f.folder.split("/");
      let node = tree;
      parts.forEach((part, idx) => {
        if (!node[part]) {
          node[part] = {
            name: part,
            path: parts.slice(0, idx + 1).join("/"),
            fileCount: 0,
            sizeBytes: 0,
            meta: db.folders && db.folders[parts.slice(0, idx + 1).join("/")] ? db.folders[parts.slice(0, idx + 1).join("/")] : {},
            children: {}
          };
        }
        node[part].fileCount++;
        node[part].sizeBytes += f.size;
        node = node[part].children;
      });
    });

    // Flatten children objects to arrays
    function flattenTree(node) {
      return Object.values(node).map(n => ({
        ...n,
        children: flattenTree(n.children)
      }));
    }

    res.json(flattenTree(tree));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 41. FILE PREVIEW METADATA (for sharing, SEO, OG tags)
app.get("/admin/preview-meta/:folder/:name", requireAuth, (req, res) => {
  const { folder, name } = req.params;
  const filePath = folder === "root"
    ? path.join(UPLOAD_PATH, name)
    : path.join(UPLOAD_PATH, folder, name);

  if (!filePath.startsWith(UPLOAD_PATH) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const stat = fs.statSync(filePath);
  const db = readDb();
  const fileKey = `${folder}/${name}`;
  const meta = db.files[fileKey] || {};
  const ext = path.extname(name).toLowerCase();

  let type = "unknown";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"].includes(ext)) type = "image";
  else if ([".mp4", ".webm", ".mov"].includes(ext)) type = "video";
  else if ([".mp3", ".wav", ".ogg", ".flac", ".aac"].includes(ext)) type = "audio";
  else if ([".pdf"].includes(ext)) type = "pdf";
  else if ([".zip", ".tar", ".gz", ".rar", ".7z", ".tar.gz", ".tar.bz2"].includes(ext)) type = "archive";
  else if ([".apk", ".aab", ".exe", ".msi", ".dmg", ".pkg", ".deb", ".rpm", ".ipa", ".appx", ".appxbundle", ".msix"].includes(ext)) type = "installer";
  else type = "code";

  const thumbFilename = `${name}-thumb.webp`;
  const hasThumb = fs.existsSync(path.join(THUMBNAIL_PATH, thumbFilename));

  res.json({
    name,
    folder,
    type,
    ext: ext.slice(1),
    sizeBytes: stat.size,
    sizeMB: (stat.size / 1024 / 1024).toFixed(2),
    createdAt: stat.birthtime,
    modifiedAt: stat.mtime,
    isPublic: meta.isPublic !== false,
    downloads: meta.downloads || 0,
    pinned: !!meta.pinned,
    tags: meta.tags || [],
    note: meta.note || "",
    expiresAt: meta.expiresAt || null,
    hash: meta.hash || null,
    thumbnailUrl: hasThumb ? (db.settings?.customBaseUrl ? `${db.settings.customBaseUrl}/thumbnails/${thumbFilename}` : `/thumbnails/${thumbFilename}`) : null,
    fileUrl: db.settings?.customBaseUrl ? `${db.settings.customBaseUrl}/file-serve/${folder}/${name}` : `/file-serve/${folder}/${name}`,
    downloadUrl: db.settings?.customBaseUrl ? `${db.settings.customBaseUrl}/file-download/${folder}/${name}` : `/file-download/${folder}/${name}`
  });
});

// =====================
// SYSTEM CONFIGURATION (ADMIN SETTINGS)
// =====================
app.get("/admin/settings", requireAuth, (req, res) => {
  const db = readDb();
  res.json(db.settings || { allowedOrigins: [] });
});

app.post("/admin/settings/origins", requireAuth, (req, res) => {
  try {
    const { origin } = req.body;
    if (!origin || typeof origin !== 'string') return res.status(400).json({ error: "Invalid origin" });
    // Basic URL validation
    if (!origin.startsWith("http://") && !origin.startsWith("https://")) {
      return res.status(400).json({ error: "Origin must start with http:// or https://" });
    }
    const db = readDb();
    if (!db.settings.allowedOrigins) db.settings.allowedOrigins = [];
    if (!db.settings.allowedOrigins.includes(origin.trim())) {
      db.settings.allowedOrigins.push(origin.trim());
      dynamicOrigins = db.settings.allowedOrigins; // Update in-memory CORS list
      writeDb(db);
      logEvent("ORIGIN_ADDED", { origin });
    }
    res.json({ success: true, allowedOrigins: db.settings.allowedOrigins });
  } catch (err) {
    console.error("[add-origin] Error:", err.message);
    res.status(500).json({ error: "Server error while saving origin", detail: err.message });
  }
});

app.delete("/admin/settings/origins", requireAuth, (req, res) => {
  const { origin } = req.body;
  const db = readDb();
  if (db.settings?.allowedOrigins) {
    db.settings.allowedOrigins = db.settings.allowedOrigins.filter(o => o !== origin);
    dynamicOrigins = db.settings.allowedOrigins; // Update in-memory
    writeDb(db);
    logEvent("ORIGIN_REMOVED", { origin });
  }
  res.json({ success: true, allowedOrigins: db.settings?.allowedOrigins || [] });
});

app.post("/admin/settings/base-url", requireAuth, (req, res) => {
  const { customBaseUrl } = req.body;
  const db = readDb();
  if (!db.settings) db.settings = {};
  
  // Format the URL to remove trailing slashes
  let formattedUrl = (customBaseUrl || "").trim();
  if (formattedUrl && formattedUrl.endsWith("/")) {
    formattedUrl = formattedUrl.slice(0, -1);
  }
  
  db.settings.customBaseUrl = formattedUrl;
  writeDb(db);
  logEvent("CUSTOM_BASE_URL_UPDATED", { customBaseUrl: formattedUrl });
  res.json({ success: true, customBaseUrl: formattedUrl });
});

app.post("/admin/settings/emails", requireAuth, (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') return res.status(400).json({ error: "Invalid email" });
  const db = readDb();
  if (!db.settings.allowedEmails) db.settings.allowedEmails = ["setupg98@gmail.com", "support@subhan.tech"];
  if (!db.settings.allowedEmails.includes(email.toLowerCase().trim())) {
    db.settings.allowedEmails.push(email.toLowerCase().trim());
    writeDb(db);
    logEvent("EMAIL_ADDED", { email: email.toLowerCase().trim() });
  }
  res.json({ success: true, allowedEmails: db.settings.allowedEmails });
});

app.delete("/admin/settings/emails", requireAuth, (req, res) => {
  const { email } = req.body;
  const db = readDb();
  if (db.settings?.allowedEmails) {
    db.settings.allowedEmails = db.settings.allowedEmails.filter(e => e !== email.toLowerCase().trim());
    writeDb(db);
    logEvent("EMAIL_REMOVED", { email: email.toLowerCase().trim() });
  }
  res.json({ success: true, allowedEmails: db.settings?.allowedEmails || [] });
});

app.post("/admin/settings/notifications/toggle", requireAuth, (req, res) => {
  const { enabled, type } = req.body;
  const db = readDb();
  if (!db.settings) db.settings = {};
  
  if (type === 'discord') {
    db.settings.discordNotificationsEnabled = !!enabled;
  } else {
    db.settings.emailNotificationsEnabled = !!enabled;
  }
  
  writeDb(db);
  logEvent("NOTIFICATIONS_TOGGLED", { enabled: !!enabled, type });
  res.json({ 
    success: true, 
    emailNotificationsEnabled: db.settings.emailNotificationsEnabled,
    discordNotificationsEnabled: db.settings.discordNotificationsEnabled
  });
});

app.post("/admin/settings/notifications/emails", requireAuth, (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') return res.status(400).json({ error: "Invalid email" });
  const db = readDb();
  if (!db.settings.notificationEmails) db.settings.notificationEmails = ["support@subhan.tech"];
  if (!db.settings.notificationEmails.includes(email.toLowerCase().trim())) {
    db.settings.notificationEmails.push(email.toLowerCase().trim());
    writeDb(db);
    logEvent("NOTIFICATION_EMAIL_ADDED", { email: email.toLowerCase().trim() });
  }
  res.json({ success: true, notificationEmails: db.settings.notificationEmails });
});

app.delete("/admin/settings/notifications/emails", requireAuth, (req, res) => {
  const { email } = req.body;
  const db = readDb();
  if (db.settings?.notificationEmails) {
    db.settings.notificationEmails = db.settings.notificationEmails.filter(e => e !== email.toLowerCase().trim());
    writeDb(db);
    logEvent("NOTIFICATION_EMAIL_REMOVED", { email: email.toLowerCase().trim() });
  }
  res.json({ success: true, notificationEmails: db.settings?.notificationEmails || [] });
});

app.post("/admin/settings/notifications/preferences", requireAuth, (req, res) => {
  const { preferences } = req.body;
  if (!preferences || typeof preferences !== 'object') {
    return res.status(400).json({ error: "Invalid preferences object" });
  }
  const db = readDb();
  if (!db.settings) db.settings = {};
  db.settings.notificationPreferences = {
    ...db.settings.notificationPreferences,
    ...preferences,
  };
  writeDb(db);
  logEvent("NOTIFICATION_PREFERENCES_UPDATED", { preferences });
  res.json({ success: true, notificationPreferences: db.settings.notificationPreferences });
});


// =====================
// USER AUTH DATABASE API
// =====================

const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || "";

// Middleware: require a valid Firebase ID token from the requesting user
const requireUserAuth = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// POST /auth/register — Create new user account (requires invite token)
app.post("/auth/register", async (req, res) => {
  const { email, password, name, metadata, inviteToken } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  let assignedRole = "super_admin";
  const dbData = readDb();
  
  if (Object.keys(dbData.users).length > 0) {
    if (!inviteToken) {
      return res.status(403).json({ error: "An invite token is required to register on this server." });
    }
    const invite = dbData.invites[inviteToken];
    if (!invite) {
      return res.status(403).json({ error: "Invalid or expired invite token." });
    }
    assignedRole = invite.role;
  }

  try {
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: name || "",
      emailVerified: false,
    });

    // Store profile in Firestore
    const db = admin.firestore();
    await db.collection("users").doc(userRecord.uid).set({
      uid: userRecord.uid,
      email: userRecord.email,
      name: name || "",
      avatar: "",
      role: assignedRole,
      createdAt: new Date().toISOString(),
      lastLogin: null,
      metadata: metadata || {},
    });

    // Store role and default permissions in local db.json
    const defaultPermissions = {
      super_admin: { canUpload: true, canDelete: true, canShare: true, canDownload: true },
      admin: { canUpload: true, canDelete: true, canShare: true, canDownload: true },
      home_member: { canUpload: true, canDelete: false, canShare: false, canDownload: true },
      guest: { canUpload: false, canDelete: false, canShare: false, canDownload: true }
    };

    const updatedDb = readDb();
    updatedDb.users[email] = {
      email: email,
      role: assignedRole,
      permissions: defaultPermissions[assignedRole] || defaultPermissions.guest,
      createdAt: new Date().toISOString()
    };
    if (inviteToken && updatedDb.invites[inviteToken]) {
      delete updatedDb.invites[inviteToken]; // Consume the one-time token
    }
    writeDb(updatedDb);

    // Send email verification
    try {
      if (transporter) {
        const verifyLink = await admin.auth().generateEmailVerificationLink(email);
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: email,
          subject: "Verify your email address",
          html: `
            <div style="font-family: sans-serif; padding: 40px 20px; background: #f8fafc; text-align: center;">
              <div style="max-width: 560px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 40px; box-shadow: 0 4px 12px rgba(0,0,0,0.08);">
                <h2 style="color: #4f46e5; margin-top: 0;">Verify Your Email</h2>
                <p style="color: #64748b;">Hi${name ? " " + name : ""},<br/>Click the button below to verify your email address and activate your account.</p>
                <a href="${verifyLink}" style="display:inline-block;background:#4f46e5;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:16px;">Verify Email</a>
                <p style="color:#94a3b8;font-size:13px;margin-top:24px;">If you didn't create an account, you can safely ignore this email.</p>
              </div>
            </div>`,
        });
      }
    } catch (_) { /* Non-fatal: verification email might fail */ }

    res.status(201).json({
      success: true,
      uid: userRecord.uid,
      email: userRecord.email,
      message: "Account created. Check your email to verify your address.",
    });
  } catch (err) {
    if (err.code === "auth/email-already-exists") {
      return res.status(409).json({ error: "An account with this email already exists." });
    }
    console.error("Register error:", err);
    res.status(500).json({ error: err.message || "Registration failed" });
  }
});

// POST /auth/login — Sign in with email + password, returns idToken
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  if (!FIREBASE_WEB_API_KEY) {
    return res.status(503).json({ error: "FIREBASE_WEB_API_KEY is not configured on the server." });
  }
  try {
    const axios = require("axios");
    const fbRes = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
      { email, password, returnSecureToken: true },
      { timeout: 8000 }
    );
    const { idToken, localId: uid, expiresIn } = fbRes.data;

    // Update lastLogin in Firestore
    try {
      const db = admin.firestore();
      await db.collection("users").doc(uid).update({ lastLogin: new Date().toISOString() });
    } catch (_) {}

    // Fetch profile
    let profile = {};
    try {
      const db = admin.firestore();
      const doc = await db.collection("users").doc(uid).get();
      if (doc.exists) profile = doc.data();
    } catch (_) {}

    res.json({ success: true, token: idToken, expiresIn, uid, profile });
  } catch (err) {
    const code = err?.response?.data?.error?.message;
    if (code === "EMAIL_NOT_FOUND" || code === "INVALID_PASSWORD" || code === "INVALID_LOGIN_CREDENTIALS") {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    if (code === "TOO_MANY_ATTEMPTS_TRY_LATER") {
      return res.status(429).json({ error: "Too many failed attempts. Please try again later." });
    }
    console.error("Login error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Login failed." });
  }
});

// POST /auth/forgot-password — Send a password reset email
app.post("/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });
  try {
    const resetLink = await admin.auth().generatePasswordResetLink(email);
    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: "Reset your password",
        html: `
          <div style="font-family: sans-serif; padding: 40px 20px; background: #f8fafc; text-align: center;">
            <div style="max-width: 560px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 40px; box-shadow: 0 4px 12px rgba(0,0,0,0.08);">
              <h2 style="color: #ef4444; margin-top: 0;">Reset Your Password</h2>
              <p style="color: #64748b;">We received a request to reset your password. Click the button below to choose a new one.</p>
              <a href="${resetLink}" style="display:inline-block;background:#ef4444;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:16px;">Reset Password</a>
              <p style="color:#94a3b8;font-size:13px;margin-top:24px;">If you didn't request this, you can safely ignore this email.</p>
            </div>
          </div>`,
      });
    }
    res.json({ success: true, message: "Password reset email sent." });
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      // Return success anyway to prevent email enumeration
      return res.json({ success: true, message: "Password reset email sent." });
    }
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Failed to send password reset email." });
  }
});

// POST /auth/verify-email — (Re)send an email verification link
app.post("/auth/verify-email", requireUserAuth, async (req, res) => {
  try {
    const verifyLink = await admin.auth().generateEmailVerificationLink(req.user.email);
    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: req.user.email,
        subject: "Verify your email address",
        html: `<div style="font-family:sans-serif;padding:40px 20px;background:#f8fafc;text-align:center;"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;"><h2 style="color:#4f46e5;margin-top:0;">Verify Your Email</h2><p style="color:#64748b;">Click below to verify your email address.</p><a href="${verifyLink}" style="display:inline-block;background:#4f46e5;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:16px;">Verify Email</a></div></div>`,
      });
    }
    res.json({ success: true, message: "Verification email sent." });
  } catch (err) {
    res.status(500).json({ error: "Failed to send verification email." });
  }
});

// GET /auth/me — Get the current user's profile
app.get("/auth/me", requireUserAuth, async (req, res) => {
  try {
    const db = admin.firestore();
    const doc = await db.collection("users").doc(req.user.uid).get();
    
    let profileData = doc.exists ? doc.data() : { email: req.user.email, name: req.user.name || "" };
    
    const dbData = readDb();
    const userRecord = dbData.users[req.user.email];
    
    // Inject true RBAC role and permissions from db.json into the profile response
    if (userRecord) {
      profileData.role = userRecord.role;
      const defaultPermissions = {
        super_admin: { canUpload: true, canDelete: true, canShare: true, canDownload: true },
        admin: { canUpload: true, canDelete: true, canShare: true, canDownload: true },
        home_member: { canUpload: true, canDelete: false, canShare: false, canDownload: true },
        guest: { canUpload: false, canDelete: false, canShare: false, canDownload: true }
      };
      // Merge default permissions with user-specific overrides
      profileData.permissions = {
        ...(defaultPermissions[userRecord.role] || defaultPermissions.guest),
        ...(userRecord.permissions || {})
      };
    } else {
      profileData.role = "user";
      profileData.permissions = { canUpload: false, canDelete: false, canShare: false, canDownload: true };
    }

    res.json({ success: true, profile: profileData });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch profile." });
  }
});

// =====================
// RBAC & USER MANAGEMENT
// =====================

app.post("/api/invites/generate", requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!["super_admin", "admin", "home_member", "guest"].includes(role)) {
    return res.status(400).json({ error: "Invalid role specified." });
  }

  // Only super_admin can create another super_admin or admin
  if ((role === "super_admin" || role === "admin") && req.userRole !== "super_admin") {
    return res.status(403).json({ error: "Only Super Admins can generate invites for Admins." });
  }

  const token = crypto.randomBytes(16).toString("hex");
  const dbData = readDb();
  
  dbData.invites[token] = {
    role,
    createdBy: req.user.email,
    createdAt: new Date().toISOString()
  };
  
  writeDb(dbData);
  logEvent("INVITE_GENERATED", { role, by: req.user.email });
  
  res.json({ success: true, token, role });
});

app.get("/api/users", requireAdmin, (req, res) => {
  const dbData = readDb();
  res.json({ success: true, users: dbData.users, invites: dbData.invites });
});

app.delete("/api/users/:email", requireSuperAdmin, async (req, res) => {
  const targetEmail = req.params.email;
  const dbData = readDb();
  
  if (targetEmail === "setupg98@gmail.com") {
    return res.status(403).json({ error: "The primary owner account cannot be deleted." });
  }

  if (targetEmail === req.user.email) {
    return res.status(400).json({ error: "You cannot delete your own account." });
  }
  
  if (!dbData.users[targetEmail]) {
    return res.status(404).json({ error: "User not found." });
  }
  
  // Try to delete from Firebase
  try {
    const userRecord = await admin.auth().getUserByEmail(targetEmail);
    await admin.auth().deleteUser(userRecord.uid);
    const db = admin.firestore();
    await db.collection("users").doc(userRecord.uid).delete();
  } catch (err) {
    console.warn(`Could not delete ${targetEmail} from Firebase (might already be deleted):`, err.message);
  }

  delete dbData.users[targetEmail];
  writeDb(dbData);
  logEvent("USER_DELETED", { targetEmail, by: req.user.email });
  
  res.json({ success: true });
});

app.put("/api/users/:email/role", requireSuperAdmin, (req, res) => {
  const targetEmail = req.params.email;
  const { role } = req.body;
  
  if (!["super_admin", "admin", "home_member", "guest"].includes(role)) {
    return res.status(400).json({ error: "Invalid role." });
  }

  if (targetEmail === "setupg98@gmail.com" && role !== "super_admin") {
    return res.status(403).json({ error: "The primary owner account must remain a super admin." });
  }
  
  const dbData = readDb();
  if (!dbData.users[targetEmail]) {
    return res.status(404).json({ error: "User not found." });
  }
  
  dbData.users[targetEmail].role = role;
  writeDb(dbData);
  logEvent("USER_ROLE_CHANGED", { targetEmail, newRole: role, by: req.user.email });
  
  res.json({ success: true, user: dbData.users[targetEmail] });
});

app.put("/api/users/:email/permissions", requireSuperAdmin, (req, res) => {
  const targetEmail = req.params.email;
  const { permissions } = req.body;
  
  if (targetEmail === "setupg98@gmail.com") {
    return res.status(403).json({ error: "Cannot modify the primary owner's permissions." });
  }
  
  const dbData = readDb();
  if (!dbData.users[targetEmail]) {
    return res.status(404).json({ error: "User not found." });
  }
  
  // Merge the existing permissions (if any) with the new overrides
  dbData.users[targetEmail].permissions = {
    ...(dbData.users[targetEmail].permissions || {}),
    ...permissions
  };
  
  writeDb(dbData);
  logEvent("USER_PERMISSIONS_CHANGED", { targetEmail, newPermissions: permissions, by: req.user.email });
  
  res.json({ success: true, permissions: dbData.users[targetEmail].permissions });
});

app.delete("/api/invites/:token", requireAdmin, (req, res) => {
  const { token } = req.params;
  const dbData = readDb();
  
  if (!dbData.invites[token]) {
    return res.status(404).json({ error: "Invite not found." });
  }
  
  delete dbData.invites[token];
  writeDb(dbData);
  res.json({ success: true });
});

// PUT /auth/me — Update the current user's profile
app.put("/auth/me", requireUserAuth, async (req, res) => {
  const { name, avatar, metadata } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (avatar !== undefined) updates.avatar = avatar;
  if (metadata !== undefined) updates.metadata = metadata;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No fields to update provided." });
  }
  try {
    const db = admin.firestore();
    await db.collection("users").doc(req.user.uid).update(updates);
    if (name) {
      await admin.auth().updateUser(req.user.uid, { displayName: name });
    }
    res.json({ success: true, updated: updates });
  } catch (err) {
    res.status(500).json({ error: "Failed to update profile." });
  }
});

// DELETE /auth/me — Delete the current user's own account
app.delete("/auth/me", requireUserAuth, async (req, res) => {
  try {
    const db = admin.firestore();
    await db.collection("users").doc(req.user.uid).delete();
    await admin.auth().deleteUser(req.user.uid);
    res.json({ success: true, message: "Account deleted." });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete account." });
  }
});

// GET /admin/users — List all users (api-key protected)
app.get("/admin/users", requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const db = admin.firestore();
    const snapshot = await db.collection("users").orderBy("createdAt", "desc").limit(limit).get();
    const users = snapshot.docs.map(doc => doc.data());
    res.json({ success: true, count: users.length, users });
  } catch (err) {
    res.status(500).json({ error: "Failed to list users." });
  }
});

// GET /admin/users/:uid — Get a specific user
app.get("/admin/users/:uid", requireAuth, async (req, res) => {
  try {
    const db = admin.firestore();
    const doc = await db.collection("users").doc(req.params.uid).get();
    if (!doc.exists) return res.status(404).json({ error: "User not found." });
    res.json({ success: true, profile: doc.data() });
  } catch (err) {
    res.status(500).json({ error: "Failed to get user." });
  }
});

// PUT /admin/users/:uid — Update any user's profile or role
app.put("/admin/users/:uid", requireAuth, async (req, res) => {
  const { name, avatar, role, metadata } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (avatar !== undefined) updates.avatar = avatar;
  if (role !== undefined) updates.role = role;
  if (metadata !== undefined) updates.metadata = metadata;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No fields to update provided." });
  }
  try {
    const db = admin.firestore();
    await db.collection("users").doc(req.params.uid).update(updates);
    if (name) await admin.auth().updateUser(req.params.uid, { displayName: name });
    res.json({ success: true, updated: updates });
  } catch (err) {
    res.status(500).json({ error: "Failed to update user." });
  }
});

// DELETE /admin/users/:uid — Delete any user
app.delete("/admin/users/:uid", requireAuth, async (req, res) => {
  try {
    const db = admin.firestore();
    await db.collection("users").doc(req.params.uid).delete();
    await admin.auth().deleteUser(req.params.uid);
    res.json({ success: true, message: "User deleted." });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user." });
  }
});

// =====================
// SYSTEM CONTROLS
// =====================

// POST /admin/system/reboot — reboots the host machine using provided password
app.post("/admin/system/reboot", requireAuth, (req, res) => {
  logEvent("SYSTEM_REBOOT", { triggeredBy: req.user?.email || "unknown" });
  // Respond FIRST so the client receives the success before the connection drops
  res.json({ success: true, message: "Server is rebooting…" });
  setTimeout(() => {
    exec("echo subhan | sudo -S reboot", (err) => {
      if (err) console.error("Reboot command failed:", err.message);
    });
  }, 500);
});

// POST /admin/system/shutdown — shuts down the host machine using provided password
app.post("/admin/system/shutdown", requireAuth, (req, res) => {
  logEvent("SYSTEM_SHUTDOWN", { triggeredBy: req.user?.email || "unknown" });
  res.json({ success: true, message: "Server is shutting down…" });
  setTimeout(() => {
    exec("echo subhan | sudo -S shutdown -h now", (err) => {
      if (err) console.error("Shutdown command failed:", err.message);
    });
  }, 500);
});

// =====================
// MAKE-A-COPY (BACKUPS) ENGINE
// =====================
async function createBackup() {
  return new Promise((resolve, reject) => {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupFilename = `backup-${timestamp}.zip`;
      const backupFilepath = path.join(BACKUPS_PATH, backupFilename);

      const output = fs.createWriteStream(backupFilepath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", () => {
        const sizeBytes = archive.pointer();
        const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
        console.log(`⚡ Backup completed: ${backupFilename} (${sizeMB} MB)`);
        
        logEvent("BACKUP_CREATED", { filename: backupFilename, sizeBytes, sizeMB });
        sendSystemAlertEmail(
          "Backup Created Successfully",
          `A redundant server backup has been created: <strong>${backupFilename}</strong> (${sizeMB} MB).`,
          "💾"
        );

        // Keep only the 7 most recent backups
        try {
          const files = fs.readdirSync(BACKUPS_PATH)
            .filter(f => f.startsWith("backup-") && f.endsWith(".zip"))
            .map(f => ({
              name: f,
              path: path.join(BACKUPS_PATH, f),
              time: fs.statSync(path.join(BACKUPS_PATH, f)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);

          if (files.length > 7) {
            const filesToDelete = files.slice(7);
            for (const file of filesToDelete) {
              fs.unlinkSync(file.path);
              logEvent("BACKUP_DELETED_OLD", { filename: file.name });
            }
          }
        } catch (cleanupErr) {
          console.error("Error cleaning up old backups:", cleanupErr);
        }

        resolve({ filename: backupFilename, sizeBytes });
      });

      archive.on("error", (err) => {
        console.error("Backup archive error:", err);
        logEvent("BACKUP_FAILED", { error: err.message });
        sendSystemAlertEmail(
          "Backup Failed",
          `Server backup failed to create. Error: ${err.message}`,
          "❌"
        );
        reject(err);
      });

      archive.pipe(output);

      // We want to backup MobileBackups directory, but if it doesn't exist, we will backup all other user directories inside UPLOAD_PATH.
      const mobileBackupsPath = path.join(UPLOAD_PATH, "MobileBackups");
      if (fs.existsSync(mobileBackupsPath)) {
        archive.directory(mobileBackupsPath, "MobileBackups");
      } else {
        // Fallback: Backup all files and folders under UPLOAD_PATH EXCEPT _thumbnails, _trash, and _backups
        const items = fs.readdirSync(UPLOAD_PATH);
        for (const item of items) {
          if (item === "_thumbnails" || item === "_trash" || item === "_backups" || item === "db.json") {
            continue;
          }
          const itemPath = path.join(UPLOAD_PATH, item);
          const stat = fs.statSync(itemPath);
          if (stat.isDirectory()) {
            archive.directory(itemPath, item);
          } else {
            archive.file(itemPath, { name: item });
          }
        }
      }

      archive.finalize();
    } catch (err) {
      console.error("Backup creation failed:", err);
      logEvent("BACKUP_FAILED", { error: err.message });
      reject(err);
    }
  });
}

// Schedule automated daily backups at 2 AM
cron.schedule("0 2 * * *", () => {
  console.log("⏰ Running scheduled daily backup...");
  createBackup().catch(err => console.error("Scheduled backup failed:", err));
});

// GET /admin/backups — lists all available ZIP backups
app.get("/admin/backups", requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(BACKUPS_PATH)
      .filter(f => f.startsWith("backup-") && f.endsWith(".zip"))
      .map(f => {
        const filePath = path.join(BACKUPS_PATH, f);
        const stat = fs.statSync(filePath);
        return {
          name: f,
          size: stat.size,
          createdAt: stat.mtime
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: "Failed to list backups" });
  }
});

// POST /admin/backups/create — trigger a manual backup
app.post("/admin/backups/create", requireAuth, async (req, res) => {
  try {
    const result = await createBackup();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to create backup" });
  }
});

// GET /admin/backups/download/:filename — downloads a specific backup zip
app.get("/admin/backups/download/:filename", requireAuth, (req, res) => {
  const { filename } = req.params;
  const safeFilename = filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const filePath = path.join(BACKUPS_PATH, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Backup not found" });
  }

  logEvent("BACKUP_DOWNLOADED", { filename: safeFilename, triggeredBy: req.user?.email || "unknown" });
  res.download(filePath, safeFilename);
});

// DELETE /admin/backups/:filename — deletes a backup file
app.delete("/admin/backups/:filename", requireAuth, (req, res) => {
  const { filename } = req.params;
  const safeFilename = filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const filePath = path.join(BACKUPS_PATH, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Backup not found" });
  }

  try {
    fs.unlinkSync(filePath);
    logEvent("BACKUP_DELETED", { filename: safeFilename, triggeredBy: req.user?.email || "unknown" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete backup" });
  }
});

// =====================
// PUBLIC ROUTES
// =====================
app.get("/api/public-files", (req, res) => {
  // Return only files where isPublic is explicitly true
  const publicFiles = fileCache.filter(file => file.isPublic === true);
  res.json(publicFiles);
});

// =====================
// SERVER SYSTEM METRICS (SSE)
// =====================
app.get("/admin/system/stream", requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // flush the headers to establish SSE

  const sendMetrics = () => {
    osUtils.cpuUsage((cpuPercent) => {
      const metrics = {
        cpu: Math.round(cpuPercent * 100),
        memory: Math.round((1 - osUtils.freememPercentage()) * 100),
        uptime: os.uptime(),
        timestamp: Date.now()
      };
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(metrics)}\n\n`);
      }
    });
  };

  // Send first metric instantly
  sendMetrics();
  
  // Stream metrics every 1 second
  const intervalId = setInterval(sendMetrics, 1000);

  req.on('close', () => {
    clearInterval(intervalId);
  });
});

// =====================
// DEPLOYMENTS API
// =====================
app.get("/api/deployments/projects", requireAuth, (req, res) => {
  res.json(deploymentEngine.readProjects());
});

app.get("/api/deployments/tunnel-cname", requireAuth, (req, res) => {
  res.json({ cname: cloudflareManager.getTunnelCname() });
});

app.get("/api/deployments/check-port", requireAuth, async (req, res) => {
  const { port } = req.query;
  if (!port) return res.status(400).json({ error: "Port is required" });
  
  const isFree = await deploymentEngine.checkPortAvailability(Number(port));
  res.json({ success: true, free: isFree, port: Number(port) });
});

app.post("/api/deployments/projects", requireAuth, (req, res) => {
  const project = deploymentEngine.createProject(req.body);
  res.json({ success: true, project });
});

app.post("/api/deployments/projects/:id", requireAuth, async (req, res) => {
  const oldProject = deploymentEngine.getProject(req.params.id);
  const project = deploymentEngine.updateProject(req.params.id, req.body);
  
  // Calculate removed and added domains
  const oldDomains = oldProject?.domains || [];
  const newDomains = req.body.domains !== undefined ? req.body.domains : (project.domains || []);
  
  const removedDomains = oldDomains.filter(d => !newDomains.includes(d));
  const addedDomains = newDomains.filter(d => !oldDomains.includes(d));

  // Remove deleted domains from Cloudflare
  for (const domain of removedDomains) {
    try {
      await cloudflareManager.deleteRoute(domain);
    } catch (e) {
      console.warn(`Failed to remove old Cloudflare route for ${domain}:`, e.message);
    }
  }

  // Add new domains to Cloudflare instantly if running
  if (project.status === 'running' && project.port) {
    for (const domain of addedDomains) {
      try {
        await cloudflareManager.addRoute(domain, project.port);
      } catch (e) {
        console.warn(`Failed to instantly add new Cloudflare route for ${domain}:`, e.message);
      }
    }
  }
  
  res.json({ success: true, project });
});

app.delete("/api/deployments/projects/:id", requireAuth, async (req, res) => {
  try {
    const project = deploymentEngine.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    
    // Stop the project if running
    await deploymentEngine.stopProject(project.id);
    
    // Remove Cloudflare routes if it has domains
    if (project.domains && project.domains.length > 0) {
      for (const domain of project.domains) {
        try {
          await cloudflareManager.deleteRoute(domain);
        } catch (e) {
          console.warn(`Failed to remove Cloudflare route for ${domain}:`, e.message);
        }
      }
    }
    
    // Delete files
    const projectDir = path.join(deploymentEngine.APPS_DIR, project.id);
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    
    const logFile = path.join(deploymentEngine.LOGS_DIR, `${project.id}.log`);
    if (fs.existsSync(logFile)) {
      fs.rmSync(logFile);
    }
    
    // Remove from projects.json
    deploymentEngine.deleteProject(project.id);
    
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/deployments/trigger/:id", requireAuth, (req, res) => {
  const { id } = req.params;
  const project = deploymentEngine.getProject(id);
  // Trigger asynchronously
  deploymentEngine.deployProject(id).then(() => {
    sendSystemAlertEmail(`Deploy Succeeded: ${project.name}`, `Your project has successfully been built and deployed to production.`, "✅");
  }).catch(e => {
    sendSystemAlertEmail(`Deploy Failed: ${project.name}`, `Your project deployment failed with error:<br><br><code>${e.message}</code>`, "❌");
    console.error(e);
  });
  res.json({ success: true, message: "Deployment started" });
});

app.post("/api/deployments/stop/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  await deploymentEngine.stopProject(id);
  res.json({ success: true, message: "Project stopped" });
});

app.post("/api/deployments/env/:id", requireAuth, (req, res) => {
  const { id } = req.params;
  const project = deploymentEngine.updateProject(id, { env: req.body.env });
  res.json({ success: true, project });
});

app.post("/api/deployments/rollback/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await deploymentEngine.rollbackProject(id);
    res.json({ success: true, message: "Rollback completed" });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Logs endpoint via SSE
app.get("/api/deployments/logs/:id", (req, res) => {
  const { id } = req.params;
  const token = req.query.token;
  // Allow token via query param since EventSource can't set headers
  if (!token) return res.status(401).end();
  const logFile = path.join(deploymentEngine.LOGS_DIR, `${id}.log`);
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  // Always send initial content (empty string if deploy hasn't started writing logs yet)
  const initialLogs = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  res.write(`data: ${JSON.stringify({ logs: initialLogs })}\n\n`);

  const watcher = fs.watch(deploymentEngine.LOGS_DIR, (eventType, filename) => {
    if (filename === `${id}.log`) {
      try {
        const logs = fs.readFileSync(logFile, "utf8");
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ logs })}\n\n`);
        }
      } catch(e) {}
    }
  });

  req.on('close', () => {
    watcher.close();
  });
});
// AI Auto-Fix Endpoints
app.get("/api/settings/ai", requireAuth, (req, res) => {
  const db = readDb();
  if (!db.settings) db.settings = {};
  if (!db.settings.ai) db.settings.ai = { provider: "openrouter", model: "google/gemini-2.5-flash", apiKey: "" };
  res.json({ success: true, aiSettings: db.settings.ai });
});

app.get("/api/settings/ai/ollama-models", requireAuth, async (req, res) => {
  try {
    const axios = require('axios');
    const response = await axios.get('http://127.0.0.1:11434/api/tags');
    res.json({ success: true, models: response.data.models.map(m => m.name) });
  } catch (error) {
    res.status(500).json({ error: "Failed to connect to Ollama. Is it running on localhost:11434?" });
  }
});

app.post("/api/settings/ai", requireAuth, (req, res) => {
  const db = readDb();
  if (!db.settings) db.settings = {};
  db.settings.ai = req.body.settings;
  writeDb(db);
  res.json({ success: true, message: "AI settings saved successfully." });
});

app.post("/api/deployments/fix/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { logs } = req.body;
  const project = deploymentEngine.getProject(id);
  const db = readDb();
  const aiSettings = db.settings?.ai || { provider: "openrouter", model: "google/gemini-2.5-flash", apiKey: "" };
  
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (aiSettings.provider === 'openrouter' && !aiSettings.apiKey) {
    return res.status(400).json({ error: "OpenRouter API key is missing. Please configure it in AI Settings." });
  }

  try {
    const liveDir = path.join(deploymentEngine.WEBSITES_DIR, id);
    const fixResult = await fixWithAI(id, logs || "", liveDir, aiSettings);
    
    // Automatically trigger a redeploy after applying the fix
    deploymentEngine.startDeployment(id);

    res.json({ success: true, fix: fixResult });
  } catch (error) {
    console.error("Auto-Fix failed:", error);
    res.status(500).json({ error: error.message || "Failed to run AI auto-fix." });
  }
});

app.post("/api/deployments/webhook", (req, res) => {
  const { projectId } = req.query;
  const projects = deploymentEngine.readProjects();

  const recordHistory = (proj, trigger, commit) => {
    const history = proj.deploymentHistory || [];
    history.unshift({ id: crypto.randomUUID(), triggeredBy: trigger, commit: commit || null, timestamp: new Date().toISOString(), status: "building" });
    deploymentEngine.updateProject(proj.id, { deploymentHistory: history.slice(0, 20) });
  };

  const updateHistoryStatus = (projId, status) => {
    const p = deploymentEngine.getProject(projId);
    if (!p) return;
    const history = p.deploymentHistory || [];
    if (history[0]) history[0].status = status;
    deploymentEngine.updateProject(projId, { deploymentHistory: history });
  };

  if (projectId) {
    const project = projects.find(p => p.id === projectId);
    if (project) {
      // Verify HMAC signature if a webhook secret is set
      const secret = project.webhookSecret;
      if (secret) {
        const signature = req.headers["x-hub-signature-256"];
        if (!signature) return res.status(401).json({ success: false, message: "Missing signature" });
        const rawBody = JSON.stringify(req.body);
        const expectedSig = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
        if (signature !== expectedSig) return res.status(401).json({ success: false, message: "Invalid signature" });
      }

      // Respect autoDeploy toggle (default: enabled for backwards compat)
      if (project.autoDeploy === false) {
        return res.json({ success: false, message: "Auto-deploy is disabled for this project" });
      }

      const commit = req.body?.head_commit?.message || null;
      recordHistory(project, "deploy-hook", commit);
      deploymentEngine.deployProject(projectId).then(() => {
        updateHistoryStatus(projectId, "success");
        if (project.discordNotify !== false)
          sendSystemAlertEmail(`Deploy Succeeded: ${project.name}`, `Your project was deployed automatically via webhook.`, "✅");
      }).catch(e => {
        updateHistoryStatus(projectId, "failed");
        if (project.discordNotify !== false)
          sendSystemAlertEmail(`Deploy Failed: ${project.name}`, `Your webhook deployment failed with error:<br><br><code>${e.message}</code>`, "❌");
        console.error(e);
      });
      return res.json({ success: true, message: `Webhook triggered deployment for ${project.name}` });
    }
    return res.status(404).json({ success: false, message: "Project not found" });
  }

  // Fallback: generic GitHub App / push event matching by repo name + branch
  const payload = req.body;
  if (payload && payload.repository) {
    const branch = payload.ref ? payload.ref.replace("refs/heads/", "") : "main";
    const matchingProject = projects.find(p =>
      p.repository.includes(payload.repository.name) && p.branch === branch && p.autoDeploy !== false
    );

    if (matchingProject) {
      const commit = payload.head_commit?.message || null;
      recordHistory(matchingProject, "github-push", commit);
      deploymentEngine.deployProject(matchingProject.id).then(() => {
        updateHistoryStatus(matchingProject.id, "success");
        if (matchingProject.discordNotify !== false)
          sendSystemAlertEmail(`Deploy Succeeded: ${matchingProject.name}`, `Your GitHub push automatically built and deployed your project.`, "✅");
      }).catch(e => {
        updateHistoryStatus(matchingProject.id, "failed");
        if (matchingProject.discordNotify !== false)
          sendSystemAlertEmail(`Deploy Failed: ${matchingProject.name}`, `Your GitHub push deployment failed with error:<br><br><code>${e.message}</code>`, "❌");
        console.error(e);
      });
      return res.json({ success: true, message: `Webhook triggered deployment for ${matchingProject.name}` });
    }
  }
  res.json({ success: false, message: "No matching project found for webhook" });
});

// Get webhook status for a project (public for checking)
app.get("/api/deployments/webhook-status/:id", requireAuth, (req, res) => {
  const project = deploymentEngine.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json({
    autoDeploy: project.autoDeploy !== false,
    discordNotify: project.discordNotify !== false,
    webhookSecret: project.webhookSecret ? true : false,
    deploymentHistory: project.deploymentHistory || []
  });
});

// =====================
// GITHUB INTEGRATIONS API
// =====================
app.get("/api/github/repos", requireAuth, async (req, res) => {
  try {
    const repos = await githubIntegrations.fetchGithubRepos();
    res.json({ success: true, repos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/github/branches", requireAuth, async (req, res) => {
  try {
    const { repo } = req.query;
    if (!repo) return res.status(400).json({ error: "Repo is required" });
    const branches = await githubIntegrations.fetchGithubBranches(repo);
    res.json({ success: true, branches });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/github/scan", requireAuth, async (req, res) => {
  try {
    const { repo, branch, rootDir } = req.query;
    if (!repo) return res.status(400).json({ error: "Repo is required" });
    const scanResult = await githubIntegrations.scanGithubRepo(repo, branch, rootDir);
    res.json({ success: true, scanResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/integrations/github", requireAuth, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required" });
  githubIntegrations.saveGithubToken(token);
  res.json({ success: true, message: "Token saved successfully" });
});

app.post("/api/github/webhook/setup", requireAuth, async (req, res) => {
  try {
    const { repoUrl, webhookUrl } = req.body;
    if (!repoUrl || !webhookUrl) return res.status(400).json({ error: "Missing required fields" });
    
    const parsed = new URL(repoUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return res.status(400).json({ error: "Invalid GitHub URL" });
    
    let repoName = parts[1];
    if (repoName.endsWith(".git")) repoName = repoName.slice(0, -4);
    const repoFullName = `${parts[0]}/${repoName}`;

    const result = await githubIntegrations.createGithubWebhook(repoFullName, webhookUrl);
    res.json({ success: true, message: result.message || "Webhook successfully created" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/github/login", (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send("GITHUB_CLIENT_ID is not configured in .env.local");
  }
  
  const proto = req.headers['x-forwarded-proto'] || (req.headers.host && req.headers.host.includes('localhost') ? 'http' : 'https');
  let host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host && host.includes(':5000')) host = host.replace(':5000', ':3000');
  
  const callbackUrl = process.env.FRONTEND_URL 
    ? `${process.env.FRONTEND_URL}/api/github/callback` 
    : `${proto}://${host}/api/github/callback`;

  const redirectUri = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=repo,admin:repo_hook`;
  res.redirect(redirectUri);
});

app.get("/api/github/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send("No code provided");
  }

  try {
    await githubIntegrations.exchangeCodeForToken(code);
    
    const proto = req.headers['x-forwarded-proto'] || (req.headers.host && req.headers.host.includes('localhost') ? 'http' : 'https');
    let host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host && host.includes(':5000')) host = host.replace(':5000', ':3000');
    
    const frontendUrl = process.env.FRONTEND_URL || `${proto}://${host}`;
    res.redirect(`${frontendUrl}/deployments?github_connected=true`);
  } catch (err) {
    console.error("OAuth error:", err.message);
    res.status(500).send("Failed to authenticate with GitHub: " + err.message);
  }
});

app.get("/api/integrations/github", requireAuth, (req, res) => {
  const token = githubIntegrations.getGithubToken();
  res.json({ success: true, connected: !!token });
});

// =====================
// CLOUDFLARE TUNNEL API
// =====================
app.get("/api/cloudflare/routes", requireAuth, (req, res) => {
  try {
    const routes = cloudflareManager.getRoutes();
    res.json({ success: true, routes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/cloudflare/routes", requireAuth, async (req, res) => {
  const { hostname, port } = req.body;
  try {
    await cloudflareManager.addRoute(hostname, port);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/cloudflare/routes", requireAuth, async (req, res) => {
  const { hostname } = req.body;
  try {
    await cloudflareManager.deleteRoute(hostname);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/cloudflare/restart", requireAuth, async (req, res) => {
  try {
    await cloudflareManager.restartTunnel();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =====================
// HEALTH & GENERAL
// =====================
app.get("/api/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  if (req.query.code) {
    return res.redirect(`/api/github/callback?code=${req.query.code}`);
  }
  res.send("Storage Server Admin API Running 🔒");
});

// =====================
// WATCHDOG API
// =====================
app.get("/api/watchdog/status", requireAuth, (req, res) => {
  res.json(watchdog.getWatchdogState());
});

app.get("/api/watchdog/logs", requireAuth, (req, res) => {
  res.json(watchdog.getWatchdogLogs(100));
});

app.post("/api/watchdog/settings", requireAuth, (req, res) => {
  const { config } = req.body;
  const state = watchdog.getWatchdogState();
  state.config = { ...state.config, ...config };
  watchdog.writeWatchdogState(state);
  watchdog.appendLog("info", "system", "config_update", "Watchdog settings updated via API.");
  // Restart watchdog to apply new interval if changed
  watchdog.stopWatchdog();
  if (state.config.enabled) {
    watchdog.startWatchdog();
  }
  res.json({ success: true, message: "Settings saved" });
});

app.post("/api/watchdog/action", requireAuth, (req, res) => {
  const { action, service } = req.body;
  watchdog.appendLog("warning", "manual", "manual_action", `Manual action triggered: ${action} on ${service || 'system'}`);
  if (action === "reboot") {
    exec("sudo reboot");
    return res.json({ success: true, message: "Reboot initiated" });
  } else if (action === "restart_service" && service) {
    exec(`sudo systemctl restart ${service}`);
    return res.json({ success: true, message: `Service ${service} restart initiated` });
  } else if (action === "update_backend") {
    const backendDir = __dirname;
    res.json({ success: true, message: "Backend update started. Server will restart in a few seconds." });
    setTimeout(() => {
      exec(`cd "${backendDir}" && git pull origin main`, (err, stdout, stderr) => {
        if (err) { console.error("[self-update] git pull failed:", stderr || err.message); return; }
        console.log("[self-update] git pull:", stdout);
        exec("pm2 restart cloud-backend", (err2) => {
          if (err2) console.error("[self-update] pm2 restart failed:", err2.message);
          else console.log("[self-update] cloud-backend restarted.");
        });
      });
    }, 300);
    return;
  }
  res.status(400).json({ error: "Invalid action" });
});

// =====================
// SERVER SELF-UPDATE
// =====================
app.post("/api/server/update", requireAuth, (req, res) => {
  const backendDir = __dirname;
  res.json({ success: true, message: "Update started. Server will restart shortly." });
  setTimeout(() => {
    exec(`cd "${backendDir}" && git pull origin main`, (err, stdout, stderr) => {
      if (err) {
        console.error("[self-update] git pull failed:", stderr || err.message);
        return;
      }
      console.log("[self-update] git pull success:", stdout);
      exec("pm2 restart cloud-backend", (err2) => {
        if (err2) console.error("[self-update] pm2 restart failed:", err2.message);
        else console.log("[self-update] cloud-backend restarted successfully.");
      });
    });
  }, 500);
});

// =====================
// SECURE VAULT
// =====================
const vaultTokens = {};

app.get("/api/vault/status", requireAuth, (req, res) => {
  const db = readDb();
  const email = req.user.email || req.user.uid;
  const isSetup = !!(db.vaults && db.vaults[email] && db.vaults[email].pinHash);
  res.json({ enabled: isSetup });
});

app.post("/api/vault/setup", requireAuth, (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: "PIN is required" });
  const db = readDb();
  const email = req.user.email || req.user.uid;
  const pinHash = crypto.createHash("sha256").update(pin).digest("hex");
  if (!db.vaults) db.vaults = {};
  db.vaults[email] = { pinHash, createdAt: new Date().toISOString() };
  writeDb(db);
  res.json({ success: true });
});

app.post("/api/vault/change-pin", requireAuth, (req, res) => {
  const { currentPin, newPin } = req.body;
  if (!currentPin || !newPin) return res.status(400).json({ error: "Current PIN and New PIN are required" });
  const db = readDb();
  const email = req.user.email || req.user.uid;
  
  if (!db.vaults || !db.vaults[email] || !db.vaults[email].pinHash) {
    return res.status(400).json({ error: "Vault not configured" });
  }

  const currentPinHash = crypto.createHash("sha256").update(currentPin).digest("hex");
  if (db.vaults[email].pinHash !== currentPinHash) {
    return res.status(403).json({ error: "Incorrect current PIN" });
  }

  const newPinHash = crypto.createHash("sha256").update(newPin).digest("hex");
  db.vaults[email].pinHash = newPinHash;
  writeDb(db);
  res.json({ success: true });
});

app.post("/api/vault/forgot-pin", requireAuth, async (req, res) => {
  try {
    const db = readDb();
    const email = req.user.email || req.user.uid;
    
    // Generate a 6-digit OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    
    if (!db.mfaCodes) db.mfaCodes = {};
    db.mfaCodes[email] = { code, expiresAt };
    writeDb(db);

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Secure Vault PIN Reset Code",
      text: `Your Secure Vault PIN reset code is: ${code}\nThis code will expire in 10 minutes.`,
      html: `<h2>Secure Vault PIN Reset</h2><p>Your PIN reset code is: <strong>${code}</strong></p><p>This code will expire in 10 minutes.</p>`,
    };

    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: "Verification email sent" });
  } catch (error) {
    console.error("Failed to send reset code:", error);
    res.status(500).json({ error: "Failed to send reset code" });
  }
});

app.post("/api/vault/reset-pin", requireAuth, (req, res) => {
  const { code, newPin } = req.body;
  if (!code || !newPin) return res.status(400).json({ error: "Code and New PIN are required" });
  const db = readDb();
  const email = req.user.email || req.user.uid;
  
  if (!db.mfaCodes || !db.mfaCodes[email]) {
    return res.status(400).json({ error: "Invalid or expired reset code" });
  }
  
  if (db.mfaCodes[email].code !== code) {
    return res.status(400).json({ error: "Incorrect reset code" });
  }
  
  if (Date.now() > db.mfaCodes[email].expiresAt) {
    delete db.mfaCodes[email];
    writeDb(db);
    return res.status(400).json({ error: "Reset code has expired" });
  }
  
  const newPinHash = crypto.createHash("sha256").update(newPin).digest("hex");
  if (!db.vaults) db.vaults = {};
  if (!db.vaults[email]) db.vaults[email] = { createdAt: new Date().toISOString() };
  
  db.vaults[email].pinHash = newPinHash;
  delete db.mfaCodes[email];
  writeDb(db);
  
  res.json({ success: true });
});

app.post("/api/vault/verify", requireAuth, (req, res) => {
  const { pin } = req.body;
  const db = readDb();
  const email = req.user.email || req.user.uid;
  const vault = db.vaults?.[email];
  if (!vault) return res.status(400).json({ error: "Vault not set up" });
  
  const pinHash = crypto.createHash("sha256").update(pin).digest("hex");
  if (vault.pinHash !== pinHash) return res.status(401).json({ error: "Incorrect PIN" });
  
  const token = crypto.randomBytes(32).toString("hex");
  vaultTokens[token] = { email, expires: Date.now() + 30 * 60 * 1000 };
  res.json({ token });
});

app.post("/api/vault/disable", requireAuth, (req, res) => {
  const { pin } = req.body;
  const db = readDb();
  const email = req.user.email || req.user.uid;
  const vault = db.vaults?.[email];
  if (!vault) return res.status(400).json({ error: "Vault not set up" });
  
  const pinHash = crypto.createHash("sha256").update(pin).digest("hex");
  if (vault.pinHash !== pinHash) return res.status(401).json({ error: "Incorrect PIN" });
  
  delete db.vaults[email];
  writeDb(db);
  res.json({ success: true });
});

app.post("/api/vault/move-in", requireAuth, (req, res) => {
  const { folder, name } = req.body;
  const email = req.user.email || req.user.uid;
  const sourcePath = path.join(UPLOAD_PATH, folder, name);
  const destDir = path.join(UPLOAD_PATH, "_vault", email);
  const destPath = path.join(destDir, name);
  
  if (!fs.existsSync(sourcePath)) return res.status(404).json({ error: "File not found" });
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  
  fs.renameSync(sourcePath, destPath);
  
  const index = fileCache.findIndex(f => f.folder === folder && f.name === name);
  if (index !== -1) {
    fileCache.splice(index, 1);
  }
  
  res.json({ success: true });
});

app.post("/api/vault/bulk-move-in", requireAuth, (req, res) => {
  const { files } = req.body;
  if (!Array.isArray(files) || files.length === 0)
    return res.status(400).json({ error: "Files array required" });

  const email = req.user.email || req.user.uid;
  const destDir = path.join(UPLOAD_PATH, "_vault", email);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  let moved = 0;
  files.forEach(({ folder, name }) => {
    const sourcePath = path.join(UPLOAD_PATH, folder, name);
    const destPath = path.join(destDir, name);
    
    if (fs.existsSync(sourcePath)) {
      fs.renameSync(sourcePath, destPath);
      
      const index = fileCache.findIndex(f => f.folder === folder && f.name === name);
      if (index !== -1) {
        fileCache.splice(index, 1);
      }
      moved++;
    }
  });

  res.json({ success: true, moved });
});

app.post("/api/vault/move-out", requireAuth, (req, res) => {
  const { folder, name } = req.body;
  const email = req.user.email || req.user.uid;
  const sourcePath = path.join(UPLOAD_PATH, "_vault", email, name);
  const destDir = path.join(UPLOAD_PATH, folder);
  const destPath = path.join(destDir, name);
  
  if (!fs.existsSync(sourcePath)) return res.status(404).json({ error: "Vault file not found" });
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  
  fs.renameSync(sourcePath, destPath);
  
  const stats = fs.statSync(destPath);
  let type = "unknown";
  const ext = path.extname(name).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".svg"].includes(ext)) type = "image";
  else if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) type = "video";
  else if ([".pdf"].includes(ext)) type = "pdf";
  else if ([".html", ".htm"].includes(ext)) type = "html";
  else if ([".zip", ".rar", ".7z", ".tar", ".gz"].includes(ext)) type = "archive";
  else if ([".exe", ".apk", ".msi", ".dmg"].includes(ext)) type = "installer";
  else if ([".txt", ".md", ".json", ".csv", ".xml"].includes(ext)) type = "code";

  fileCache.push({
    name: name,
    folder: folder,
    size: stats.size,
    type,
    createdAt: stats.birthtime.toISOString(),
    url: `/file-serve/${folder}/${name}`,
    isPublic: false,
    pinned: false,
    downloads: 0
  });

  res.json({ success: true });
});

app.get("/api/vault/files", requireAuth, (req, res) => {
  const token = req.headers["x-vault-token"] || req.query.vault_token;
  const email = req.user.email || req.user.uid;
  if (!token || !vaultTokens[token] || vaultTokens[token].email !== email || vaultTokens[token].expires < Date.now()) {
    return res.status(401).json({ error: "Unauthorized vault access" });
  }
  
  const vaultDir = path.join(UPLOAD_PATH, "_vault", email);
  if (!fs.existsSync(vaultDir)) return res.json([]);
  
  const files = fs.readdirSync(vaultDir);
  const fileData = files.map(file => {
    const fullPath = path.join(vaultDir, file);
    const stats = fs.statSync(fullPath);
    let type = "unknown";
    const ext = path.extname(file).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".svg"].includes(ext)) type = "image";
    else if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) type = "video";
    else if ([".pdf"].includes(ext)) type = "pdf";
    else if ([".html", ".htm"].includes(ext)) type = "html";
    else if ([".zip", ".rar", ".7z", ".tar", ".gz"].includes(ext)) type = "archive";
    else if ([".exe", ".apk", ".msi", ".dmg"].includes(ext)) type = "installer";
    else if ([".txt", ".md", ".json", ".csv", ".xml"].includes(ext)) type = "code";
    
    return {
      name: file,
      folder: "_vault",
      size: stats.size,
      type,
      createdAt: stats.birthtime.toISOString(),
      url: `/api/vault/file-serve/${encodeURIComponent(file)}?vault_token=${token}`,
      isPublic: false,
      pinned: false,
      downloads: 0
    };
  });
  
  res.json(fileData);
});

app.get("/api/vault/file-serve/:name", (req, res) => {
  const token = req.query.vault_token;
  if (!token || !vaultTokens[token] || vaultTokens[token].expires < Date.now()) {
    return res.status(401).send("Unauthorized");
  }
  const email = vaultTokens[token].email;
  const name = req.params.name;
  const fullPath = path.join(UPLOAD_PATH, "_vault", email, name);
  if (!fs.existsSync(fullPath)) return res.status(404).send("File not found");
  res.sendFile(fullPath);
});

// =====================
// START
// =====================
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("Storage Admin API running on port", PORT);
  watchdog.startWatchdog();
  if (cloudflareManager && cloudflareManager.autoFixLocalhost) {
    cloudflareManager.autoFixLocalhost();
  }
});

// Prevent 502 Bad Gateway errors for long/large uploads
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

// =====================
// WEBSOCKET TERMINAL
// =====================
try {
  const WebSocket = require("ws");
  const pty = require("node-pty");

  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    // Only handle /terminal upgrades
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname !== "/terminal") {
      socket.destroy();
      return;
    }

    // Authenticate via token query param
    const token = url.searchParams.get("token");
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      const dbData = readDb();
      const authorizedEmails = dbData.settings?.allowedEmails?.length
        ? dbData.settings.allowedEmails
        : ["setupg98@gmail.com", "support@subhan.tech"];
      if (!authorizedEmails.includes(decoded.email)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    console.log("🖥️  Terminal WebSocket connected");

    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "bash");
    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: process.env.HOME || process.cwd(),
      env: process.env,
    });

    ptyProcess.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", exitCode }));
        ws.close();
      }
    });

    ws.on("message", (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type === "input") {
          ptyProcess.write(parsed.data);
        } else if (parsed.type === "resize") {
          ptyProcess.resize(parsed.cols, parsed.rows);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      console.log("🖥️  Terminal WebSocket disconnected");
      try { ptyProcess.kill(); } catch {}
    });
  });

  console.log("⚡ WebSocket terminal server initialized on /terminal");
} catch (e) {
  console.warn("⚠️  WebSocket terminal disabled (node-pty or ws not installed):", e.message);
  console.warn("   To enable: npm install ws node-pty");
}

