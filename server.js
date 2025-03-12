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
const Authorize = require('./models/Authorize');
const Unit = require('./models/Unit');
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

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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

const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many signup attempts. Try again later.',
});

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Routes and webhook handling
const { router, sendMessage } = require('./routes/webhook');
app.use('/webhook', router);

// Image upload route for properties, units, and tenants
app.get('/upload-image/:phoneNumber/:type/:id', (req, res) => {
  const { phoneNumber, type, id } = req.params;
  res.render('uploadImage', { phoneNumber, type, id });
});

app.post('/upload-image/:phoneNumber/:type/:id', upload.single('image'), async (req, res) => {
  const { phoneNumber, type, id } = req.params;

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

    res.send('Image uploaded successfully!');
  } catch (error) {
    console.error(`Error uploading image for ${type}:`, error);
    await sendMessage(phoneNumber, `❌ *Error* \nFailed to upload image. Please try again using the same link: ${req.headers.origin}/upload-image/${phoneNumber}/${type}/${id}`);
    res.status(500).send('Error uploading image.');
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});