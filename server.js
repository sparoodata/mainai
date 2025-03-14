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
const crypto = require('crypto');
const AWS = require('aws-sdk');

// === Mongoose Models ===
const Tenant = require('./models/Tenant');
const Image = require('./models/Image');
const Property = require('./models/Property');
const User = require('./models/User');
const Unit = require('./models/Unit');
const UploadToken = require('./models/UploadToken');

// === AWS S3 / Cloudflare R2 ===
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT, 
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});

// === Express App Setup ===
const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// === Security & Performance Middlewares ===
app.use(helmet());
app.use(compression());
app.use(morgan('combined'));

// === Rate Limiter ===
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100,
});
app.use(limiter);

// === Body Parser ===
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === MongoDB Connection ===
mongoose.set('strictQuery', false);
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('MongoDB connected'))
  .catch(error => console.error('MongoDB error:', error));

// === Session Setup ===
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(20).toString('hex'),
  resave: false,
  saveUninitialized: false,
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

// === Static Files ===
app.use(express.static(path.join(__dirname, 'public')));

// === Multer (in-memory) for File Uploads ===
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, 
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads allowed!'), false);
    }
    cb(null, true);
  }
});

// === Import Webhook Router ===
const { router, sendMessage } = require('./routes/webhook');
app.use('/webhook', router);

// === Upload Token Validation ===
async function validateUploadToken(req, res, next) {
  const token = req.method === 'GET' ? req.query.token : req.body.token;
  if (!token) {
    return res.status(403).send('No token provided.');
  }
  try {
    const uploadToken = await UploadToken.findOne({ token });
    if (!uploadToken) {
      return res.status(403).send('Invalid or expired token.');
    }
    if (uploadToken.used) {
      return res.status(403).send('This upload link has already been used.');
    }
    if (new Date() > uploadToken.expiresAt) {
      return res.status(403).send('This upload link has expired.');
    }
    req.uploadToken = uploadToken;
    next();
  } catch (error) {
    console.error('Token validation error:', error);
    res.status(500).send('Server error during token validation.');
  }
}

// === GET: Render Upload Page ===
app.get('/upload-image/:phoneNumber/:type/:id', validateUploadToken, (req, res) => {
  const { phoneNumber, type, id } = req.params;
  const { token } = req.query;
  res.render('uploadImage', { phoneNumber, type, id, token });
});

// === POST: Handle Image Upload ===
app.post('/upload-image/:phoneNumber/:type/:id', upload.single('image'), validateUploadToken, async (req, res) => {
  const { phoneNumber, type, id } = req.params;
  const { token } = req.body;

  try {
    // 1) Upload to R2
    const key = `images/${Date.now()}-${req.file.originalname}`;
    const uploadParams = {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };
    await s3.upload(uploadParams).promise();

    // 2) Save Image Doc
    const imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
    const imageDoc = new Image({ [`${type}Id`]: id, imageUrl });
    await imageDoc.save();

    // 3) Update Entity
    if (type === 'property') {
      const prop = await Property.findById(id);
      if (!prop.images) prop.images = [];
      prop.images.push(imageDoc._id);
      await prop.save();
      await sendMessage(phoneNumber, `Image uploaded successfully for property: ${prop.name}`);
    } else if (type === 'unit') {
      const unit = await Unit.findById(id);
      if (!unit.images) unit.images = [];
      unit.images.push(imageDoc._id);
      await unit.save();
      await sendMessage(phoneNumber, `Image uploaded successfully for unit: ${unit.unitId}`);
    } else if (type === 'tenant') {
      const tenant = await Tenant.findById(id);
      tenant.photo = imageUrl;
      await tenant.save();
      await sendMessage(phoneNumber, `Photo uploaded successfully for tenant: ${tenant.name}`);
    }

    // 4) Mark Token Used
    req.uploadToken.used = true;
    await req.uploadToken.save();

    // 5) Respond
    res.send('Image uploaded successfully!');
  } catch (error) {
    console.error(`Error uploading image for ${type}:`, error);
    // Provide a simple error message
    await sendMessage(phoneNumber, 'Error uploading image. Please try again using the same link.');
    res.status(500).send('Error uploading image.');
  }
});

// === 404 & Error Handlers ===
app.use((req, res) => {
  res.status(404).send('404 Not Found');
});
app.use((err, req, res, next) => {
  console.error('General Error:', err.stack);
  res.status(500).send('Something went wrong!');
});

// === Start Server ===
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
