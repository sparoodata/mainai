const express = require('express');
const AWS = require('aws-sdk');
const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require('path');

const router = express.Router();

// Configure AWS SDK for R2 (S3-compatible)
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT, // e.g., "https://<account>.r2.cloudflarestorage.com"
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  s3ForcePathStyle: true,
});

// Updated fileFilter: Reject .webp files explicitly.
function fileFilter(req, file, cb) {
  // Explicitly reject .webp files
  if (file.mimetype === 'image/webp') {
    return cb(new Error('Only JPG and PNG images are allowed'), false);
  }
  // Allowed types: jpg, jpeg, png
  const allowedTypes = /jpeg|jpg|png/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);
  if (mimetype && extname) {
    return cb(null, true);
  } else {
    return cb(new Error('Only JPG and PNG images are allowed'), false);
  }
}

// Configure multer to use multerS3 with a file size limit of 5MB, allowing up to 5 images.
const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.R2_BUCKET,
    acl: 'public-read',
    key: function (req, file, cb) {
      const filename = Date.now() + '-' + file.originalname;
      cb(null, filename);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter
});

// Endpoint to handle multiple image uploads for a property (or other entity)
router.post('/upload-image/:phone/:type/:entityId', (req, res) => {
  // The client should display a loading spinner while this endpoint is processing.
  upload.array('images', 5)(req, res, (err) => {
    if (err) {
      // If file type or size validation fails, return the error message.
      return res.status(400).json({ success: false, error: err.message });
    }
    // On success, get the uploaded file locations.
    const imageUrls = req.files.map(file => file.location);
    // For example, if type is "property", update the property document.
    if (req.params.type === 'property') {
      const Property = require('../models/Property');
      Property.findById(req.params.entityId)
        .then(property => {
          // Append new image URLs to the existing images array.
          property.images = property.images.concat(imageUrls);
          return property.save();
        })
        .then(() => res.json({ success: true, imageUrls }))
        .catch(error => res.status(500).json({ success: false, error: error.message }));
    } else {
      res.json({ success: true, imageUrls });
    }
  });
});

module.exports = router;
