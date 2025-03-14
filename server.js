require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const path = require('path');
const AWS = require('aws-sdk');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

// --- Security & Performance Middleware ---
app.use(helmet());
app.use(morgan('combined')); // Logging HTTP requests
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per window
    message: 'Too many requests from this IP, please try again later.',
  })
);

// --- Built-in Body Parser ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- MongoDB Connection ---
mongoose.set('strictQuery', false);
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('MongoDB connected'))
  .catch((error) => console.error('MongoDB connection error:', error));

// --- Session Management ---
app.set('trust proxy', 1);
app.use(
  session({
    secret: process.env.SESSION_SECRET,
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
  })
);

// --- View Engine & Static Files ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// --- AWS S3 (R2) Setup ---
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});

// --- Multer for File Uploads ---
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// --- Import Models & Routes ---
const Tenant = require('./models/Tenant');
const Image = require('./models/Image');
const Property = require('./models/Property');
const User = require('./models/User');
const Unit = require('./models/Unit');
const UploadToken = require('./models/UploadToken');
const { router: webhookRouter, sendMessage } = require('./routes/webhook');

// --- Custom Middleware: Validate Upload Token ---
async function validateUploadToken(req, res, next) {
  const token = req.method === 'GET' ? req.query.token : req.body.token;
  console.log(`Validating token: ${token}, Method: ${req.method}`);

  if (!token) {
    return res.status(403).send('No token provided.');
  }

  try {
    const uploadToken = await UploadToken.findOne({ token });
    if (!uploadToken) return res.status(403).send('Invalid or expired token.');
    if (uploadToken.used)
      return res.status(403).send('This upload link has already been used.');
    if (new Date() > uploadToken.expiresAt)
      return res.status(403).send('This upload link has expired.');

    req.uploadToken = uploadToken;
    next();
  } catch (error) {
    console.error('Error validating token:', error);
    return res.status(500).send('Server error during token validation.');
  }
}

// --- Image Upload Routes ---
app.get(
  '/upload-image/:phoneNumber/:type/:id',
  validateUploadToken,
  (req, res) => {
    const { phoneNumber, type, id } = req.params;
    const { token } = req.query;
    res.render('uploadImage', { phoneNumber, type, id, token });
  }
);

app.post(
  '/upload-image/:phoneNumber/:type/:id',
  upload.single('image'),
  validateUploadToken,
  async (req, res) => {
    const { phoneNumber, type, id } = req.params;
    const { token } = req.body;

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
      const image = new Image({ [`${type}Id`]: id, imageUrl });
      await image.save();

      let entity;
      if (type === 'property') {
        entity = await Property.findById(id);
        entity.images.push(image._id);
        await entity.save();
        await sendMessage(
          phoneNumber,
          `✅ *Success*\nImage uploaded successfully for property "${entity.name}".`
        );
      } else if (type === 'unit') {
        entity = await Unit.findById(id);
        entity.images.push(image._id);
        await entity.save();
        await sendMessage(
          phoneNumber,
          `✅ *Success*\nImage uploaded successfully for unit "${entity.unitNumber}".`
        );
      } else if (type === 'tenant') {
        entity = await Tenant.findById(id);
        entity.photo = imageUrl;
        await entity.save();
        await sendMessage(
          phoneNumber,
          `✅ *Success*\nPhoto uploaded successfully for tenant "${entity.name}".`
        );
      }

      req.uploadToken.used = true;
      await req.uploadToken.save();
      res.send('Image uploaded successfully!');
    } catch (error) {
      console.error(`Error uploading image for ${type}:`, error);
      // Generate retry URL and send a message with a short URL
      const retryUrl = `${process.env.GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${id}?token=${token}`;
      const axios = require('axios');
      const shortUrl = await axios
        .post(
          'https://tinyurl.com/api-create.php?url=' +
            encodeURIComponent(retryUrl)
        )
        .then((res) => res.data)
        .catch(() => retryUrl);
      await sendMessage(
        phoneNumber,
        `❌ *Error*\nFailed to upload image. Please try again using this link: ${shortUrl}`
      );
      res.status(500).send('Error uploading image.');
    }
  }
);

// --- Use the Webhook Routes ---
app.use('/webhook', webhookRouter);

// --- Global Error Handler (optional) ---
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'An unexpected error occurred.' });
});

// --- Start the Server ---
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
