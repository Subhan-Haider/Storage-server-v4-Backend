# ☁️ LootOps Cloud - Backend API

This repository contains the standalone Express.js backend API for the LootOps Cloud platform. It handles file storage, media processing (images/video), database interactions, Firebase authentication verification, and CI/CD webhook deployments.

## ✨ Core Features
- **File Management**: Upload, download, move, delete, and zip files.
- **Media Processing**: Automatic image thumbnails via `sharp` and video compression via `ffmpeg`.
- **Security**: Firebase ID Token verification, Speakeasy 2FA, Helmet, and rate-limiting.
- **CI/CD Orchestration**: Built-in deployment engine to pull, build, and deploy GitHub repositories atomically.
- **Cloudflare Tunnels**: Dynamic ingress routing for deployed projects.

---

## 🚀 Installation & Setup

Ensure your server has Node.js (v20+) and PM2 installed.

### 1. Clone the Repository
```bash
git clone https://github.com/Subhan-Haider/Storage-server-v4-Backend.git
cd Storage-server-v4-Backend
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Variables
Create a `.env.local` file in the root directory:
```bash
nano .env.local
```
Add your required API keys and configuration:
```env
# Server
PORT=5000
SERVER_BASE_URL=https://api.yourdomain.com
UPLOAD_PATH=/var/www/storage/uploads
API_KEY=your_secure_api_key

# Firebase Admin
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=your-service-account@...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# GitHub Integrations
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
```

### 4. Start the Server
Run the API using PM2 so it stays alive in the background:
```bash
pm2 start server.js --name server-backend
pm2 save
pm2 startup
```

---

## 📁 Key Files
- `server.js` - Main Express router and core endpoint logic.
- `deployment_engine.js` - CI/CD pipeline for building Next.js/React/Vite apps.
- `cloudflare_manager.js` - YAML parser and updater for Cloudflared ingress rules.
- `github_integrations.js` - OAuth2 handler for GitHub repos.
- `watchdog.js` - Process monitor to auto-restart crashed deployments.

---

## 🔗 Architecture Notes
This API is designed to be completely decoupled from the frontend. It runs independently on port `5000` (by default) and expects the frontend to proxy or send authenticated API requests directly to it. All endpoints (except public file serving) require a valid `Authorization: Bearer <Firebase_ID_Token>` header.
