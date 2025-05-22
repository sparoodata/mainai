require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const path = require('path');
const axios = require("axios");
const multer = require('multer');
const crypto = require('crypto');
const AWS = require('aws-sdk');

// Updated models
const Property = require('./models/Property');
const Unit = require('./models/Unit');
const Tenant = require('./models/Tenant');
const User = require('./models/User');
const UploadToken = require('./models/UploadToken');

const { router, sendMessage, sendSummary } = require('./routes/webhook');

const app = express();
const port = process.env.PORT || 3000;
const groqRoute = require('./routes/groq');

// Use Groq route for messages starting with '/'
app.use('/groq', groqRoute);
// Configure AWS R2 (S3 compatible)
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Parse JSON and URL-encoded data
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

mongoose.set('strictQuery', false);
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('MongoDB connected'))
  .catch(error => console.error('MongoDB connection error:', error));

// Use sessions stored in MongoDB
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

app.use(express.static(path.join(__dirname, 'public')));

// Multer setup for file uploads (memory storage)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Use the webhook router for WhatsApp interactions
app.use('/webhook', router);

// Middleware to validate the upload token for image uploads
async function validateUploadToken(req, res, next) {
  // For GET requests, token is in query; for POST requests, it's in the body
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
    req.uploadToken = uploadToken;
    next();
  } catch (error) {
    console.error('Error validating token:', error);
    res.status(500).send('Server error during token validation.');
  }
}

// GET route to render the image upload page (make sure you have an "uploadImage.ejs" in your views folder)
app.get('/upload-image/:phoneNumber/:type/:id', validateUploadToken, (req, res) => {
  const { phoneNumber, type, id } = req.params;
  const { token } = req.query;
  console.log(`Rendering upload page with token: ${token}`);
  res.render('uploadImage', { phoneNumber, type, id, token });
});

// POST route for handling image uploads
app.post('/upload-image/:phoneNumber/:type/:id', upload.single('image'), validateUploadToken, async (req, res) => {
  const { phoneNumber, type, id } = req.params;
  const { token } = req.body;
  console.log(`POST request received - Token: ${token}, File: ${req.file ? req.file.originalname : 'No file'}`);
  try {
    // Create an object key for the image in R2
    const key = `images/${Date.now()}-${req.file.originalname}`;
    const uploadParams = {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };

    // Upload the image to R2
    await s3.upload(uploadParams).promise();

    // Generate a pre-signed URL (valid for 5 minutes)
    const signedUrl = s3.getSignedUrl('getObject', {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Expires: 300,
    });
    console.log(`Image uploaded to R2 and signed URL generated: ${signedUrl}`);
    
    // Update the related entity using extended models
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
      // For tenant, we assume a single photo field
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
    const shortUrl = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(retryUrl))
      .then(response => response.data);
    await sendMessage(phoneNumber, `❌ *Error* \nFailed to upload image. Please try again using this link: ${shortUrl}`);
    res.status(500).send('Error uploading image.');
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
