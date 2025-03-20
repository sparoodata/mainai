require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const path = require('path');
const axios = require("axios");
const multer = require('multer');
const multerS3 = require('multer-s3'); // Ensure multer-s3 is installed
const crypto = require('crypto');
const AWS = require('aws-sdk');

// Models
const Property = require('./models/Property');
const Unit = require('./models/Unit');
const Tenant = require('./models/Tenant');
const User = require('./models/User');
const UploadToken = require('./models/UploadToken');

// Import your webhook router (which contains enterprise-style messaging)
const { router: webhookRouter, sendMessage, sendSummary } = require('./routes/webhook');

const app = express();
const port = process.env.PORT || 3000;

/* ----------------- AWS R2 (S3-compatible) Configuration ----------------- */
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
  s3ForcePathStyle: true,
});

/* ----------------- App Settings ----------------- */
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/* ----------------- Middleware ----------------- */
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ----------------- Routes ----------------- */
// Mount webhook route
app.use('/webhook', webhookRouter);

/* ----------------- Session Setup ----------------- */
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions',
    ttl: 3600,
  }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 3600000,
  },
}));

/* ----------------- Mongoose Connection ----------------- */
mongoose.set('strictQuery', false);
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('MongoDB connected'))
  .catch(error => console.error('MongoDB connection error:', error));

/* ----------------- Upload Image Routes (Integrated) ----------------- */

// Strict file filter: only allow .jpg, .jpeg, and .png.
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png') {
    return cb(new Error('Only JPG and PNG images are allowed'), false);
  }
  if (file.mimetype !== 'image/jpeg' && file.mimetype !== 'image/png') {
    return cb(new Error('Only JPG and PNG images are allowed'), false);
  }
  cb(null, true);
};

// Configure multer with multerS3 (5MB per file, up to 5 files)
const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.R2_BUCKET,
    acl: 'public-read',
    key: (req, file, cb) => {
      const filename = Date.now() + '-' + file.originalname;
      cb(null, filename);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter
});

// Middleware to validate the upload token
async function validateUploadToken(req, res, next) {
  const token = req.method === 'GET' ? req.query.token : req.body.token;
  console.log(`Validating token: ${token}, Method: ${req.method}`);
  if (!token) {
    return res.render('uploadImage', {
      phoneNumber: req.params.phoneNumber || '',
      type: req.params.type || '',
      id: req.params.id || '',
      token: '',
      errorMessage: 'No token provided. Please use a valid upload link.'
    });
  }
  try {
    const uploadToken = await UploadToken.findOne({ token });
    if (!uploadToken) return res.status(403).send('Invalid or expired token.');
    if (uploadToken.used) return res.status(403).send('This upload link has already been used.');
    if (new Date() > uploadToken.expiresAt) return res.status(403).send('This upload link has expired.');
    req.uploadToken = uploadToken;
    next();
  } catch (error) {
    console.error('Error validating token:', error);
    res.status(500).send('Server error during token validation.');
  }
}

// GET route to render the image upload page
app.get('/upload-image/:phoneNumber/:type/:id', validateUploadToken, (req, res) => {
  const { phoneNumber, type, id } = req.params;
  const { token } = req.query;
  console.log(`Rendering upload page with token: ${token}`);
  res.render('uploadImage', { phoneNumber, type, id, token, errorMessage: null });
});

// POST route to handle image uploads.
// If a file is invalid, re-render the page with an error message.
app.post('/upload-image/:phoneNumber/:type/:id', validateUploadToken, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      return res.render('uploadImage', {
        phoneNumber: req.params.phoneNumber,
        type: req.params.type,
        id: req.params.id,
        token: req.body.token,
        errorMessage: err.message
      });
    }
    next();
  });
}, async (req, res) => {
  const { phoneNumber, type, id } = req.params;
  const { token } = req.body;
  console.log(`POST request - Token: ${token}, File: ${req.file ? req.file.originalname : 'No file'}`);
  try {
    const key = `images/${Date.now()}-${req.file.originalname}`;
    const uploadParams = {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };

    await s3.upload(uploadParams).promise();

    // Generate a pre-signed URL (valid for 5 minutes)
    const signedUrl = s3.getSignedUrl('getObject', {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Expires: 300,
    });
    console.log(`Image uploaded and signed URL generated: ${signedUrl}`);

    let entity;
    if (type === 'property') {
      entity = await Property.findById(id);
      entity.images.push(signedUrl);
      await entity.save();
    } else if (type === 'unit') {
      entity = await Unit.findById(id);
      entity.images.push(signedUrl);
      await entity.save();
    } else if (type === 'tenant') {
      entity = await Tenant.findById(id);
      entity.photo = signedUrl;
      await entity.save();
    }

    console.log(`Sending summary for ${type} with signed URL: ${signedUrl}`);
    await sendSummary(phoneNumber, type, id, signedUrl);

    req.uploadToken.used = true;
    await req.uploadToken.save();

    res.send('Image uploaded successfully!');
  } catch (error) {
    console.error(`Error uploading image for ${type}:`, error);
    const retryUrl = `${process.env.GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${id}?token=${token}`;
    const shortUrl = await axios
      .post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(retryUrl))
      .then(response => response.data);
    await sendMessage(phoneNumber, `❌ *Error* \nFailed to upload image. Please try again using this link: ${shortUrl}`);
    res.status(500).send('Error uploading image.');
  }
});

/* ----------------- End of Upload Image Routes ----------------- */

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
