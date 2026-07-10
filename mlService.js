const path = require('path');
const fs = require('fs');

let faceapi = null;
let canvas = null;
let modelsLoaded = false;

// Simple euclidean distance
const euclideanDistance = (arr1, arr2) => {
  let sum = 0;
  for (let i = 0; i < arr1.length; i++) {
    sum += Math.pow(arr1[i] - arr2[i], 2);
  }
  return Math.sqrt(sum);
};

const initML = async () => {
  if (modelsLoaded) return;
  try {
    console.log("🤖 Initializing Face-API models...");
    canvas = require('canvas');
    faceapi = require('face-api.js');
    const { Canvas, Image, ImageData } = canvas;
    faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

    const modelsPath = path.join(__dirname, 'models');
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath);
    
    modelsLoaded = true;
    console.log("✅ Face-API models loaded successfully!");
  } catch (err) {
    console.error("❌ Failed to load ML models:", err);
  }
};

const detectAndGroupFaces = async (imagePath, fileKey, readDb, writeDb) => {
  await initML();
  if (!modelsLoaded) return;

  try {
    console.log(`🤖 Running Face Detection on ${fileKey}...`);
    const img = await canvas.loadImage(imagePath);
    const detections = await faceapi.detectAllFaces(img).withFaceLandmarks().withFaceDescriptors();

    if (detections.length === 0) {
      console.log(`🤖 No faces detected in ${fileKey}.`);
      return;
    }

    console.log(`🤖 Found ${detections.length} face(s) in ${fileKey}.`);

    const db = readDb();
    if (!db.faces) db.faces = [];

    const matchedFaceIds = [];

    for (const detection of detections) {
      const descriptor = Array.from(detection.descriptor);
      
      let bestMatchId = null;
      let minDistance = 0.6; // Threshold for face match

      for (const knownFace of db.faces) {
        for (const knownDescriptor of knownFace.descriptors) {
          const distance = euclideanDistance(descriptor, knownDescriptor);
          if (distance < minDistance) {
            minDistance = distance;
            bestMatchId = knownFace.id;
          }
        }
      }

      if (bestMatchId) {
        // Matched existing face
        const faceRef = db.faces.find(f => f.id === bestMatchId);
        faceRef.descriptors.push(descriptor); // Add new angle/lighting to improve future matches
        matchedFaceIds.push(bestMatchId);
      } else {
        // Create new face
        const newFaceId = 'face_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        db.faces.push({
          id: newFaceId,
          name: `Person ${db.faces.length + 1}`,
          descriptors: [descriptor]
        });
        matchedFaceIds.push(newFaceId);
      }
    }

    // Update file metadata
    if (db.files[fileKey]) {
      db.files[fileKey].faceIds = [...new Set([...(db.files[fileKey].faceIds || []), ...matchedFaceIds])];
      writeDb(db);
      console.log(`✅ Grouped ${fileKey} into Face IDs:`, matchedFaceIds);
    }
  } catch (err) {
    console.error(`❌ Face detection failed for ${fileKey}:`, err);
  } finally {
    try {
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    } catch (e) {
      console.error("Failed to cleanup original image:", e);
    }
  }
};

module.exports = { detectAndGroupFaces };
