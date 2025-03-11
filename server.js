// server.js
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

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true}));

mongoose.set('strictQuery', false);
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => console.log('MongoDB connected'))
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

// Add Property Route (called from webhook)
app.post('/addproperty', async (req, res) => {
  const { phoneNumber, property_name, units, address, totalAmount } = req.body;

  try {
    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(404).send('User not found.');

    const property = new Property({
      name: property_name,
      units,
      address,
      totalAmount,
      userId: user._id,
    });
    await property.save();

    res.json({ propertyId: property._id });
  } catch (error) {
    console.error('Error adding property:', error);
    res.status(500).send('An error occurred while adding the property.');
  }
});

// Add Unit Route (called from webhook)
app.post('/addunit', async (req, res) => {
  const { phoneNumber, propertyId, unit_number, rent_amount, floor, size } = req.body;

  try {
    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(404).send('User not found.');

    const unit = new Unit({
      property: propertyId,
      unitNumber: unit_number,
      rentAmount: rent_amount,
      floor,
      size,
      userId: user._id,
    });
    await unit.save();

    res.json({ unitId: unit._id });
  } catch (error) {
    console.error('Error adding unit:', error);
    res.status(500).send('An error occurred while adding the unit.');
  }
});

// Add Tenant Route (called from webhook)
app.post('/addtenant', async (req, res) => {
  const { phoneNumber, name, propertyName, unitAssigned, lease_start, deposit, rent_amount, tenant_id } = req.body;

  try {
    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(404).send('User not found.');

    const unit = await Unit.findById(unitAssigned);
    if (!unit) return res.status(400).send(`No unit found with ID: ${unitAssigned}`);

    const tenant = new Tenant({
      name,
      phoneNumber: user.phoneNumber,
      userId: user._id,
      propertyName,
      unitAssigned: unit._id,
      lease_start: new Date(lease_start),
      deposit,
      rent_amount,
      tenant_id: tenant_id || generateTenantId(),
    });
    await tenant.save();

    res.json({ tenantId: tenant._id });
  } catch (error) {
    console.error('Error adding tenant:', error);
    res.status(500).send('An error occurred while adding the tenant.');
  }
});

// Image Upload Route
app.post('/upload-image/:sessionId', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'idProof', maxCount: 1 }]), async (req, res) => {
  const sessionId = req.params.sessionId;

  try {
    const sessionData = req.session[sessionId];
    if (!sessionData || !sessionData.entity || !sessionData.entityId) {
      return res.status(400).send('Invalid session or entity not found.');
    }

    const { entity, entityId, phoneNumber } = sessionData;

    if (entity === 'property') {
      const property = await Property.findById(entityId);
      if (!property) return res.status(404).send('Property not found.');

      if (req.files['photo']) {
        const key = 'images/' + Date.now() + '-' + req.files['photo'][0].originalname;
        const uploadParams = {
          Bucket: process.env.R2_BUCKET,
          Key: key,
          Body: req.files['photo'][0].buffer,
          ContentType: req.files['photo'][0].mimetype,
        };
        await s3.upload(uploadParams).promise();

        const image = new Image({ propertyId: property._id, imageUrl: key });
        await image.save();
        property.images.push(image._id);
        await property.save();
      }
    } else if (entity === 'unit') {
      const unit = await Unit.findById(entityId);
      if (!unit) return res.status(404).send('Unit not found.');

      if (req.files['photo']) {
        const key = 'images/' + Date.now() + '-' + req.files['photo'][0].originalname;
        const uploadParams = {
          Bucket: process.env.R2_BUCKET,
          Key: key,
          Body: req.files['photo'][0].buffer,
          ContentType: req.files['photo'][0].mimetype,
        };
        await s3.upload(uploadParams).promise();

        const image = new Image({ unitId: unit._id, imageUrl: key });
        await image.save();
        unit.images.push(image._id);
        await unit.save();
      }
    } else if (entity === 'tenant') {
      const tenant = await Tenant.findById(entityId);
      if (!tenant) return res.status(404).send('Tenant not found.');

      if (req.files['photo']) {
        const key = 'images/' + Date.now() + '-' + req.files['photo'][0].originalname;
        await s3.upload({ Bucket: process.env.R2_BUCKET, Key: key, Body: req.files['photo'][0].buffer, ContentType: req.files['photo'][0].mimetype }).promise();
        tenant.photo = key;
      }
      if (req.files['idProof']) {
        const key = 'images/' + Date.now() + '-' + req.files['idProof'][0].originalname;
        await s3.upload({ Bucket: process.env.R2_BUCKET, Key: key, Body: req.files['idProof'][0].buffer, ContentType: req.files['idProof'][0].mimetype }).promise();
        tenant.idProof = key;
      }
      await tenant.save();
    }

    await sendMessage(phoneNumber, `✅ *Images Uploaded Successfully* for ${entity}.`);
    delete req.session[sessionId];
    res.send('Images uploaded successfully!');
  } catch (error) {
    console.error('Error uploading images:', error);
    await sendMessage(phoneNumber, `⚠️ *Upload Failed* \nPlease upload images again using the same link.`);
    res.status(500).send('An error occurred while uploading images.');
  }
});

// Generate Tenant ID
function generateTenantId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return 'T' + digits + letter;
}

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});