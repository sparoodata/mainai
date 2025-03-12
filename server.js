require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const path = require('path');
const axios = require("axios");
const multer = require('multer');
const crypto = require('crypto');
const Tenant = require('./models/Tenant');
const Image = require('./models/Image');
const Property = require('./models/Property');
const User = require('./models/User');
const Unit = require('./models/Unit');
const UploadToken = require('./models/UploadToken');
const AWS = require('aws-sdk');

const app = express();
const port = process.env.PORT || 3000;

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

// Body-parser for JSON and URL-encoded data
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

mongoose.set('strictQuery', false);
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('MongoDB connected'))
  .catch(error => console.error('MongoDB connection error:', error));

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

// Multer setup for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

const { router, sendMessage } = require('./routes/webhook');
app.use('/webhook', router);

// Middleware to validate upload token
async function validateUploadToken(req, res, next) {
  // For GET, token is in query; for POST, it’s in body
  const token = req.method === 'GET' ? req.query.token : req.body.token;
  console.log(`Validating token: ${token}, Method: ${req.method}`); // Debug log

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

// Image upload GET route with token validation
app.get('/upload-image/:phoneNumber/:type/:id', validateUploadToken, (req, res) => {
  const { phoneNumber, type, id } = req.params;
  const { token } = req.query;
  console.log(`Rendering upload page with token: ${token}`); // Debug log
  res.render('uploadImage', { phoneNumber, type, id, token });
});

// Image upload POST route with token validation and multer
app.post('/upload-image/:phoneNumber/:type/:id', upload.single('image'), validateUploadToken, async (req, res) => {
  const { phoneNumber, type, id } = req.params;
  const { token } = req.body;

  console.log(`POST request received - Token: ${token}, File: ${req.file ? req.file.originalname : 'No file'}`); // Debug log

  try {
    const key = `images/${Date.now()}-${req.file.originalname}`;
    const uploadParams = {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };

    await s3.upload(uploadParams).promise();
    const imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
    console.log(`Image uploaded to R2: ${process.env.R2_BUCKET}/${key}`); // Debug log
    const image = new Image({ [`${type}Id`]: id, imageUrl });
    await image.save();

    let entity;
    if (type === 'property') {
      entity = await Property.findById(id);
      entity.images.push(image._id);
      await entity.save();
      await sendMessage(phoneNumber, `✅ *Success* \nImage uploaded successfully for property "${entity.name}".`);
    } else if (type === 'unit') {
      entity = await Unit.findById(id);
      entity.images.push(image._id);
      await entity.save();
      await sendMessage(phoneNumber, `✅ *Success* \nImage uploaded successfully for unit "${entity.unitNumber}".`);
    } else if (type === 'tenant') {
      entity = await Tenant.findById(id);
      entity.photo = imageUrl;
      await entity.save();
      await sendMessage(phoneNumber, `✅ *Success* \nPhoto uploaded successfully for tenant "${entity.name}".`);
    }

    req.uploadToken.used = true;
    await req.uploadToken.save();

    res.send('Image uploaded successfully!');
  } catch (error) {
    console.error(`Error uploading image for ${type}:`, error);
    const retryUrl = `${process.env.GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${id}?token=${token}`;
    const shortUrl = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(retryUrl)).then(res => res.data);
    await sendMessage(phoneNumber, `❌ *Error* \nFailed to upload image. Please try again using this link: ${shortUrl}`);
    res.status(500).send('Error uploading image.');
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});