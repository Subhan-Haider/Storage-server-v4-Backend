const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

function createLfsRouter(uploadPath, apiKey, baseUrl) {
  const router = express.Router();
  const lfsDir = path.join(uploadPath, '_lfs');

  // Ensure _lfs directory exists
  if (!fs.existsSync(lfsDir)) {
    fs.mkdirSync(lfsDir, { recursive: true });
  }

  // Basic auth middleware
  const requireLfsAuth = (req, res, next) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    // We allow any username, but password must match API_KEY
    if (password === apiKey) {
      return next();
    }

    res.set('WWW-Authenticate', 'Basic realm="LootOps Git LFS"');
    res.status(401).send('Authentication required.');
  };

  // Ensure JSON type is correct
  const requireLfsContentType = (req, res, next) => {
    // If it's the batch API, verify content type
    if (req.is('application/vnd.git-lfs+json')) {
      return next();
    }
    // But for actual upload (PUT), it's binary, so we skip this check
    next();
  };

  // POST /info/lfs/objects/batch
  // Note: we're ignoring the /:repo part by mounting this router at /lfs
  router.post('/info/lfs/objects/batch', requireLfsAuth, requireLfsContentType, (req, res) => {
    const { operation, objects } = req.body;
    
    if (!objects || !Array.isArray(objects)) {
      return res.status(400).json({ message: "Invalid payload" });
    }

    const responseObjects = objects.map(obj => {
      const { oid, size } = obj;
      const objectPath = path.join(lfsDir, oid);
      const fileExists = fs.existsSync(objectPath);
      let actualSize = 0;
      
      if (fileExists) {
        actualSize = fs.statSync(objectPath).size;
      }

      const resObj = {
        oid: oid,
        size: size,
        authenticated: true
      };

      if (operation === 'upload') {
        if (!fileExists || actualSize !== size) {
          resObj.actions = {
            upload: {
              href: `${baseUrl}/lfs/objects/${oid}`,
              header: {
                "Authorization": req.headers.authorization
              }
            }
          };
        }
      } else if (operation === 'download') {
        if (fileExists && actualSize === size) {
          resObj.actions = {
            download: {
              href: `${baseUrl}/lfs/objects/${oid}`,
              header: {
                "Authorization": req.headers.authorization
              }
            }
          };
        } else {
          resObj.error = {
            code: 404,
            message: "Object does not exist"
          };
        }
      }

      return resObj;
    });

    res.status(200).type('application/vnd.git-lfs+json').json({
      transfer: "basic",
      objects: responseObjects
    });
  });

  // Upload an object (PUT)
  router.put('/objects/:oid', requireLfsAuth, (req, res) => {
    const { oid } = req.params;
    const dest = path.join(lfsDir, oid);
    
    const writeStream = fs.createWriteStream(dest);
    
    req.pipe(writeStream);
    
    req.on('end', () => {
      res.status(200).send();
    });
    
    req.on('error', (err) => {
      console.error("LFS Upload Error:", err);
      res.status(500).send("Error uploading file");
    });
  });

  // Download an object (GET)
  router.get('/objects/:oid', requireLfsAuth, (req, res) => {
    const { oid } = req.params;
    const src = path.join(lfsDir, oid);
    
    if (!fs.existsSync(src)) {
      return res.status(404).send('Not found');
    }
    
    const stat = fs.statSync(src);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size
    });
    
    const readStream = fs.createReadStream(src);
    readStream.pipe(res);
  });

  return router;
}

module.exports = createLfsRouter;
