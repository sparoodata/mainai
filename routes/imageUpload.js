// routes/imageUpload.js
const express = require('express');
const router = express.Router();
const multer = require('multer');

const validateUploadToken = require('../middlewares/validateUploadToken');
const { uploadImageAndSave } = require('../controllers/imageController');

// Multer memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

// GET route to render the image upload page
router.get('/:phoneNumber/:type/:id', validateUploadToken, (req, res) => {
  const { phoneNumber, type, id } = req.params;
  const { token } = req.query;
  console.log(`Rendering upload page with token: ${token}`);
  res.render('uploadImage', { phoneNumber, type, id, token });
});

// POST route for handling image uploads
router.post(
  '/:phoneNumber/:type/:id',
  validateUploadToken,
  upload.single('image'),
  uploadImageAndSave
);

module.exports = router;
