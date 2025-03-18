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

// File filter: only allow files with .jpg, .jpeg, or .png extensions and corresponding mimetype.
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  console.log(ext);
  if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png') {
    return cb(new Error('Only JPG and PNG images are allowed'), false);
  }
  if (file.mimetype !== 'image/jpeg' && file.mimetype !== 'image/png') {
    return cb(new Error('Only JPG and PNG images are allowed'), false);
  }
  cb(null, true);
}

// Configure Multer using multerS3: limit file size to 5MB, allow up to 5 images.
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
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max per file
  fileFilter: fileFilter
});

/*
  POST /upload-image/:phone/:type/:entityId
  This endpoint accepts multiple image uploads (up to 5 images).
  - Only JPG/JPEG and PNG files are allowed.
  - Each file must be no more than 5MB.
  - If the file type or size is invalid, an error message is returned.
  
  Note: The client should show a loading indicator while waiting for the upload to complete.
*/
router.post('/upload-image/:phone/:type/:entityId', (req, res) => {
  upload.array('images', 5)(req, res, (err) => {
    if (err) {
      // If file validation fails, return an error message.
      return res.status(400).json({ success: false, error: err.message });
    }
    // On success, retrieve the URLs of the uploaded files.
    const imageUrls = req.files.map(file => file.location);
    
    // Example: If type is "property", update the Property document with the new images.
    if (req.params.type === 'property') {
      const Property = require('../models/Property');
      Property.findById(req.params.entityId)
        .then(property => {
          // Append the new image URLs to the existing images array.
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
