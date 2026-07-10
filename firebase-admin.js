/**
 * Firebase Admin SDK initialization for server-side token verification.
 */
const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");
const envPath = fs.existsSync(path.join(__dirname, ".env.local")) ? path.join(__dirname, ".env.local") : path.join(__dirname, "..", ".env.local");
require("dotenv").config({ path: envPath });

if (!admin.apps.length) {
  // Use environment variables for the service account credentials
  const privateKey = process.env.FIREBASE_PRIVATE_KEY 
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined;

  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && privateKey) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey,
      }),
    });
  } else {
    console.warn("⚠️ Firebase Admin credentials missing from .env.local, Firebase features will be disabled.");
  }
}

module.exports = admin;
