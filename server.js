/*********************************
 * server.js
 *********************************/

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const multer = require('multer');
const axios = require("axios");
const crypto = require('crypto');
const AWS = require('aws-sdk');

// === Load Your Mongoose Models ===
const Tenant = require('./models/Tenant');
const Image = require('./models/Image');
const Property = require('./models/Property');
const User = require('./models/User');
const Unit = require('./models/Unit');
const UploadToken = require('./models/UploadToken');

// === Initialize AWS S3 / Cloudflare R2 ===
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,      // e.g. https://<your-account-id>.r2.cloudflarestorage.com
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});

// === Express App Setup ===
const app = express();
const port = process.env.PORT || 3000;

// Set EJS as the view engine
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// === Add Security, Compression, Logging Middlewares ===
app.use(helmet());
app.use(compression());
app.use(morgan('combined'));

// === Rate Limiting (example: 100 requests per 15 minutes per IP) ===
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// === Body Parser for JSON and URL-encoded data ===
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === MongoDB Connection ===
mongoose.set('strictQuery', false);
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    // connectTimeoutMS: 10000, // optional fine-tuning
  })
  .then(() => console.log('MongoDB connected'))
  .catch(error => console.error('MongoDB connection error:', error));

// === Session Handling with MongoStore ===
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(20).toString('hex'),
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions',
    ttl: 3600, // 1 hour
  }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 3600000, // 1 hour
  },
}));

// === Static Files (for serving images, CSS, etc.) ===
app.use(express.static(path.join(__dirname, 'public')));

// === Multer Setup for File Uploads (in-memory) ===
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  // Optional: File type filter
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed!'), false);
    }
    cb(null, true);
  }
});

// === Import the webhook router ===
const { router, sendMessage } = require('./routes/webhook');
app.use('/webhook', router);

// === Middleware to Validate Upload Token ===
async function validateUploadToken(req, res, next) {
  // For GET, token is in query; for POST, it’s in body
  const token = req.method === 'GET' ? req.query.token : req.body.token;
  console.log(`Validating token: ${token}, Method: ${req.method}`);

  if (!token) {
    console.log('No token provided in request');
    return res.status(403).send('No token provided.');
  }

  try {
    const uploadToken = await UploadToken.findOne({ token });
    if (!uploadToken) {
      console.log('Token not found in database');
      return res.status(403).send('Invalid or expired token.');
    }
    if (uploadToken.used) {
      console.log('Token already used');
      return res.status(403).send('This upload link has already been used.');
    }
    if (new Date() > uploadToken.expiresAt) {
      console.log('Token expired');
      return res.status(403).send('This upload link has expired.');
    }

    req.uploadToken = uploadToken; // Pass token data to the route
    next();
  } catch (error) {
    console.error('Error validating token:', error);
    res.status(500).send('Server error during token validation.');
  }
}

// === Image Upload GET Route with Token Validation ===
app.get('/upload-image/:phoneNumber/:type/:id', validateUploadToken, (req, res) => {
  const { phoneNumber, type, id } = req.params;
  const { token } = req.query;
  console.log(`Rendering upload page with token: ${token}`);
  res.render('uploadImage', { phoneNumber, type, id, token });
});

// === Image Upload POST Route ===
app.post('/upload-image/:phoneNumber/:type/:id', upload.single('image'), validateUploadToken, async (req, res) => {
  const { phoneNumber, type, id } = req.params;
  const { token } = req.body;
  console.log(`POST /upload-image => Phone: ${phoneNumber}, Type: ${type}, ID: ${id}`);

  try {
    // Upload to Cloudflare R2 / S3
    const key = `images/${Date.now()}-${req.file.originalname}`;
    const uploadParams = {
      Bucket: process.env.R2_BUCKET,  // e.g. "my-r2-bucket"
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };

    // Perform the upload
    await s3.upload(uploadParams).promise();
    const imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
    console.log(`Image uploaded to R2: ${process.env.R2_BUCKET}/${key}`);

    // Save reference to your MongoDB
    const imageDoc = new Image({ [`${type}Id`]: id, imageUrl });
    await imageDoc.save();

    // Update relevant entity with new image
    let entity;
    if (type === 'property') {
      entity = await Property.findById(id);
      entity.images.push(imageDoc._id);
      await entity.save();
      await sendMessage(phoneNumber, `✅ *Success* \nImage uploaded successfully for property "${entity.name}".`);
    } else if (type === 'unit') {
      entity = await Unit.findById(id);
      entity.images.push(imageDoc._id);
      await entity.save();
      await sendMessage(phoneNumber, `✅ *Success* \nImage uploaded successfully for unit "${entity.unitNumber}".`);
    } else if (type === 'tenant') {
      entity = await Tenant.findById(id);
      entity.photo = imageUrl;
      await entity.save();
      await sendMessage(phoneNumber, `✅ *Success* \nPhoto uploaded successfully for tenant "${entity.name}".`);
    }

    // Mark the token as used
    req.uploadToken.used = true;
    await req.uploadToken.save();

    // Return success
    res.send('Image uploaded successfully!');
  } catch (error) {
    console.error(`Error uploading image for ${type}:`, error);

    // Provide the user a short link to retry
    const retryUrl = `${process.env.GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${id}?token=${token}`;
    let shortUrl = retryUrl; // fallback
    try {
      const tinyUrlRes = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(retryUrl));
      shortUrl = tinyUrlRes.data;
    } catch (tinyErr) {
      console.error('Error getting tinyURL:', tinyErr);
    }

    await sendMessage(phoneNumber, `❌ *Error* \nFailed to upload image. Please try again using this link: ${shortUrl}`);
    res.status(500).send('Error uploading image.');
  }
});

// === 404 Handler (Not Found) ===
app.use((req, res, next) => {
  res.status(404).send('404 Not Found');
});

// === General Error Handler ===
app.use((err, req, res, next) => {
  console.error('General Error Handler:', err.stack);
  res.status(500).send('Something went wrong!');
});

// === Start Server ===
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
