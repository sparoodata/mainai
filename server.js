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
const Tenant = require('./models/Tenant');
const Image = require('./models/Image');
const Property = require('./models/Property');
const User = require('./models/User');
const Unit = require('./models/Unit');
const AWS = require('aws-sdk');

const app = express();
const port = process.env.PORT || 3000;

// Configure the S3 client to use Cloudflare R2 settings
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

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// MongoDB connection
mongoose.set('strictQuery', false);
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('MongoDB connected'))
  .catch(error => console.error('MongoDB connection error:', error));

const cors = require('cors');
app.use(cors({
  origin: 'http://your-frontend-domain.com',
  credentials: true,
}));

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

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const { router, sendMessage } = require('./routes/webhook');
app.use('/webhook', router);

// Image upload route
app.get('/upload-image/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  res.sendFile(path.join(__dirname, 'public', 'upload.html')); // Simple HTML form for upload
});

app.post('/upload-image/:sessionId', upload.single('image'), async (req, res) => {
  const sessionId = req.params.sessionId;
  const phoneNumber = req.session[sessionId]?.phoneNumber;

  if (!phoneNumber) {
    return res.status(400).send('Session expired or invalid.');
  }

  try {
    if (req.file) {
      const key = 'images/' + Date.now() + '-' + req.file.originalname;
      const uploadParams = {
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      };

      await s3.upload(uploadParams).promise();
      req.session[sessionId].imageUrl = process.env.R2_PUBLIC_URL + '/' + key;

      await sendMessage(phoneNumber, '✅ *Image Uploaded Successfully!*');
      res.send('Image uploaded successfully!');
    } else {
      await sendMessage(phoneNumber, '⚠️ *No Image Uploaded* \nPlease upload an image using the same link.');
      res.status(400).send('No image uploaded.');
    }
  } catch (error) {
    console.error('Error uploading image:', error);
    await sendMessage(phoneNumber, '❌ *Upload Failed* \nPlease try again using the same link.');
    res.status(500).send('Error uploading image.');
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});