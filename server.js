require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const csurf = require('csurf');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const path = require('path');
const axios = require('axios');
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

// Configure S3 for Cloudflare R2
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  Bucket: process.env.R2_BUCKET,
  region: 'auto',
  signatureVersion: 'v4',
});

// Security Middleware
app.use(helmet());
app.set('trust proxy', 1);
app.use(bodyParser.json({ limit: '10kb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Connection
mongoose.set('strictQuery', true);
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('MongoDB connected'))
  .catch(error => console.error('MongoDB connection error:', error));

// Session Configuration
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    ttl: 3600,
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 3600000,
  },
}));

// CSRF Protection
const csrfProtection = csurf({ cookie: true });
app.use(csrfProtection);

// Rate Limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
});
app.use(globalLimiter);

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many attempts, please try again later.',
});

// Multer Configuration
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype) return cb(null, true);
    cb(new Error('Only JPEG/PNG images allowed'));
  },
});

// JWT Middleware
const authenticateJWT = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Routes
const { router, sendMessage } = require('./routes/webhook');
app.use('/webhook', router);

// WhatsApp Message Function
async function sendWhatsAppAuthMessage(phoneNumber) {
  const message = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: '*Authorization Request*\nDo you authorize this action?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'Yes_authorize', title: 'Yes' } },
          { type: 'reply', reply: { id: 'No_authorize', title: 'No' } },
        ],
      },
    },
  };
  await axios.post(process.env.WHATSAPP_API_URL, message, {
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

function generateTenantId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `T${digits}${letter}`;
}

// Add Property Route
app.post('/addproperty/:id', authenticateJWT, sensitiveLimiter, upload.single('image'), [
  body('property_name').trim().notEmpty().escape(),
  body('units').isInt({ min: 1 }),
  body('address').trim().notEmpty().escape(),
  body('totalAmount').isFloat({ min: 0 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { property_name, units, address, totalAmount } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).json({ error: 'Invalid or used authorization' });
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user || user._id.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const property = new Property({ name: property_name, units, address, totalAmount, userId: user._id });
    await property.save();

    if (req.file) {
      const key = `images/${Date.now()}-${req.file.originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }).promise();

      const imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
      const image = new Image({ propertyId: property._id, imageUrl });
      await image.save();
      property.images.push(image._id);
      await property.save();
    }

    await sendMessage(authorizeRecord.phoneNumber, `*Property Added*\nProperty "${property_name}" has been successfully added.`);
    await Authorize.findByIdAndDelete(id);
    res.json({ message: 'Property added successfully' });
  } catch (error) {
    console.error('Error adding property:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add Unit Route
app.post('/addunit/:id', authenticateJWT, sensitiveLimiter, upload.single('image'), [
  body('property').isMongoId(),
  body('unit_number').trim().notEmpty().escape(),
  body('rent_amount').isFloat({ min: 0 }),
  body('floor').isInt(),
  body('size').isFloat({ min: 0 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { property, unit_number, rent_amount, floor, size } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).json({ error: 'Invalid or used authorization' });
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user || user._id.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const unit = new Unit({ property, unitNumber: unit_number, rentAmount: rent_amount, floor, size, userId: user._id });
    await unit.save();

    if (req.file) {
      const key = `images/${Date.now()}-${req.file.originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }).promise();

      const imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
      const image = new Image({ unitId: unit._id, imageUrl });
      await image.save();
      unit.images.push(image._id);
      await unit.save();
    }

    const propertyDoc = await Property.findById(property);
    await sendMessage(authorizeRecord.phoneNumber, `*Unit Added*\nUnit "${unit_number}" has been added to "${propertyDoc?.name || 'Unknown'}".`);
    await Authorize.findByIdAndDelete(id);
    res.json({ message: 'Unit added successfully' });
  } catch (error) {
    console.error('Error adding unit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add Tenant Route
app.post('/addtenant/:id', authenticateJWT, sensitiveLimiter, upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'idProof', maxCount: 1 },
]), [
  body('name').trim().notEmpty().escape(),
  body('propertyName').trim().notEmpty().escape(),
  body('unitAssigned').isMongoId(),
  body('lease_start').isISO8601(),
  body('deposit').isFloat({ min: 0 }),
  body('rent_amount').isFloat({ min: 0 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, propertyName, unitAssigned, lease_start, deposit, rent_amount, tenant_id } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).json({ error: 'Invalid or used authorization' });
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user || user._id.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const unit = await Unit.findById(unitAssigned);
    if (!unit) return res.status(400).json({ error: 'Unit not found' });

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

    if (req.files.photo) {
      const key = `images/${Date.now()}-${req.files.photo[0].originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.files.photo[0].buffer,
        ContentType: req.files.photo[0].mimetype,
      }).promise();
      tenant.photo = `${process.env.R2_PUBLIC_URL}/${key}`;
    }

    if (req.files.idProof) {
      const key = `images/${Date.now()}-${req.files.idProof[0].originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.files.idProof[0].buffer,
        ContentType: req.files.idProof[0].mimetype,
      }).promise();
      tenant.idProof = `${process.env.R2_PUBLIC_URL}/${key}`;
    }

    await tenant.save();
    await sendMessage(user.phoneNumber, `*Tenant Added*\nTenant "${name}" has been added to unit "${unit.unitNumber}" at "${propertyName}".`);
    await Authorize.findByIdAndDelete(id);
    res.json({ message: 'Tenant added successfully' });
  } catch (error) {
    console.error('Error adding tenant:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Edit Property Route
app.post('/editproperty/:id', authenticateJWT, sensitiveLimiter, upload.single('image'), [
  body('propertyId').isMongoId(),
  body('property_name').trim().notEmpty().escape(),
  body('units').isInt({ min: 1 }),
  body('address').trim().notEmpty().escape(),
  body('totalAmount').isFloat({ min: 0 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { propertyId, property_name, units, address, totalAmount } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).json({ error: 'Invalid or used authorization' });
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user || user._id.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const property = await Property.findOne({ _id: propertyId, userId: user._id });
    if (!property) return res.status(404).json({ error: 'Property not found' });

    property.name = property_name;
    property.units = units;
    property.address = address;
    property.totalAmount = totalAmount;

    if (req.file) {
      const key = `images/${Date.now()}-${req.file.originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }).promise();

      const imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
      if (property.images.length > 0) {
        const image = await Image.findById(property.images[0]);
        image.imageUrl = imageUrl;
        await image.save();
      } else {
        const image = new Image({ propertyId: property._id, imageUrl });
        await image.save();
        property.images.push(image._id);
      }
    }

    await property.save();
    await sendMessage(user.phoneNumber, `*Property Updated*\nProperty "${property_name}" has been successfully updated.`);
    await Authorize.findByIdAndDelete(id);
    res.json({ message: 'Property updated successfully' });
  } catch (error) {
    console.error('Error updating property:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Edit Unit Route
app.post('/editunit/:id', authenticateJWT, sensitiveLimiter, upload.single('image'), [
  body('unitId').isMongoId(),
  body('property').isMongoId(),
  body('unit_number').trim().notEmpty().escape(),
  body('rent_amount').isFloat({ min: 0 }),
  body('floor').isInt(),
  body('size').isFloat({ min: 0 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { unitId, property, unit_number, rent_amount, floor, size } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).json({ error: 'Invalid or used authorization' });
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user || user._id.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const unit = await Unit.findOne({ _id: unitId, userId: user._id });
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    unit.property = property;
    unit.unitNumber = unit_number;
    unit.rentAmount = rent_amount;
    unit.floor = floor;
    unit.size = size;

    if (req.file) {
      const key = `images/${Date.now()}-${req.file.originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }).promise();

      const imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
      if (unit.images.length > 0) {
        const image = await Image.findById(unit.images[0]);
        image.imageUrl = imageUrl;
        await image.save();
      } else {
        const image = new Image({ unitId: unit._id, imageUrl });
        await image.save();
        unit.images.push(image._id);
      }
    }

    await unit.save();
    const propertyDoc = await Property.findById(property);
    await sendMessage(user.phoneNumber, `*Unit Updated*\nUnit "${unit_number}" in "${propertyDoc?.name || 'Unknown'}" has been updated.`);
    await Authorize.findByIdAndDelete(id);
    res.json({ message: 'Unit updated successfully' });
  } catch (error) {
    console.error('Error updating unit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Edit Tenant Route
app.post('/edittenant/:id', authenticateJWT, sensitiveLimiter, upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'idProof', maxCount: 1 },
]), [
  body('tenantId').isMongoId(),
  body('name').trim().notEmpty().escape(),
  body('propertyName').trim().notEmpty().escape(),
  body('unitAssigned').isMongoId(),
  body('lease_start').isISO8601(),
  body('deposit').isFloat({ min: 0 }),
  body('rent_amount').isFloat({ min: 0 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { tenantId, name, propertyName, unitAssigned, lease_start, deposit, rent_amount } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).json({ error: 'Invalid or used authorization' });
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user || user._id.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const tenant = await Tenant.findOne({ _id: tenantId, userId: user._id });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const unit = await Unit.findById(unitAssigned);
    if (!unit) return res.status(400).json({ error: 'Unit not found' });

    tenant.name = name;
    tenant.propertyName = propertyName;
    tenant.unitAssigned = unit._id;
    tenant.lease_start = new Date(lease_start);
    tenant.deposit = deposit;
    tenant.rent_amount = rent_amount;

    if (req.files.photo) {
      const key = `images/${Date.now()}-${req.files.photo[0].originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.files.photo[0].buffer,
        ContentType: req.files.photo[0].mimetype,
      }).promise();
      tenant.photo = `${process.env.R2_PUBLIC_URL}/${key}`;
    }

    if (req.files.idProof) {
      const key = `images/${Date.now()}-${req.files.idProof[0].originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.files.idProof[0].buffer,
        ContentType: req.files.idProof[0].mimetype,
      }).promise();
      tenant.idProof = `${process.env.R2_PUBLIC_URL}/${key}`;
    }

    await tenant.save();
    await sendMessage(user.phoneNumber, `*Tenant Updated*\nTenant "${name}" has been successfully updated.`);
    await Authorize.findByIdAndDelete(id);
    res.json({ message: 'Tenant updated successfully' });
  } catch (error) {
    console.error('Error updating tenant:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Property Route
app.post('/deleteproperty/:id', authenticateJWT, sensitiveLimiter, [
  body('propertyId').isMongoId(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { propertyId } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).json({ error: 'Invalid or used authorization' });
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user || user._id.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const property = await Property.findOneAndDelete({ _id: propertyId, userId: user._id });
    if (!property) return res.status(404).json({ error: 'Property not found' });

    await sendMessage(user.phoneNumber, `*Property Deleted*\nProperty "${property.name}" has been successfully deleted.`);
    await Authorize.findByIdAndDelete(id);
    res.json({ message: 'Property deleted successfully' });
  } catch (error) {
    console.error('Error deleting property:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Unit Route
app.post('/deleteunit/:id', authenticateJWT, sensitiveLimiter, [
  body('unitId').isMongoId(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { unitId } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).json({ error: 'Invalid or used authorization' });
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user || user._id.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const unit = await Unit.findOneAndDelete({ _id: unitId, userId: user._id });
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    await sendMessage(user.phoneNumber, `*Unit Deleted*\nUnit "${unit.unitNumber}" has been successfully deleted.`);
    await Authorize.findByIdAndDelete(id);
    res.json({ message: 'Unit deleted successfully' });
  } catch (error) {
    console.error('Error deleting unit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// OTP Routes
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOTP(phoneNumber, otp) {
  await axios.post(process.env.WHATSAPP_API_URL, {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'text',
    text: { body: `*OTP Verification*\nYour one-time password is: *${otp}*\nValid for 10 minutes.` },
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

const otpStore = new Map();

app.get('/request-otp/:id', sensitiveLimiter, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).json({ error: 'Authorization not found' });

    const otp = generateOTP();
    otpStore.set(authorizeRecord.phoneNumber, { otp, attempts: 0, expires: Date.now() + 600000 });
    await sendOTP(authorizeRecord.phoneNumber, otp);
    req.session.phoneNumber = authorizeRecord.phoneNumber;
    res.json({ message: 'OTP sent' });
  } catch (error) {
    console.error('Error requesting OTP:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/validate-otp/:id', sensitiveLimiter, [
  body('otp').isNumeric().isLength({ min: 6, max: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { otp } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).json({ error: 'Authorization not found' });

    const storedOTPData = otpStore.get(authorizeRecord.phoneNumber);
    if (!storedOTPData || storedOTPData.expires < Date.now()) {
      return res.status(400).json({ error: 'OTP expired or not requested' });
    }

    if (storedOTPData.attempts >= 3) {
      return res.status(429).json({ error: 'Too many attempts' });
    }

    if (otp === storedOTPData.otp) {
      const token = jwt.sign({ id: authorizeRecord.phoneNumber }, process.env.JWT_SECRET, { expiresIn: '1h' });
      otpStore.delete(authorizeRecord.phoneNumber);
      let redirectUrl;
      switch (authorizeRecord.action) {
        case 'addproperty': redirectUrl = `/addproperty/${id}`; break;
        case 'editproperty': redirectUrl = `/editproperty/${id}`; break;
        case 'addunit': redirectUrl = `/addunit/${id}`; break;
        case 'editunit': redirectUrl = `/editunit/${id}`; break;
        case 'addtenant': redirectUrl = `/addtenant/${id}`; break;
        case 'edittenant': redirectUrl = `/edittenant/${id}`; break;
        default: redirectUrl = '/';
      }
      res.json({ message: 'OTP validated', token, redirect: redirectUrl });
    } else {
      storedOTPData.attempts += 1;
      res.status(400).json({ error: 'Invalid OTP' });
    }
  } catch (error) {
    console.error('Error validating OTP:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Render Routes
app.get('/addproperty/:id', authenticateJWT, async (req, res) => {
  const id = req.params.id;
  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization');
    }
    res.render('addProperty', { id, csrfToken: req.csrfToken() });
  } catch (error) {
    console.error('Error rendering add property:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/editproperty/:id', authenticateJWT, async (req, res) => {
  const id = req.params.id;
  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization');
    }
    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    const properties = await Property.find({ userId: user._id });
    res.render('editProperty', { id, properties, csrfToken: req.csrfToken() });
  } catch (error) {
    console.error('Error rendering edit property:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/addunit/:id', authenticateJWT, async (req, res) => {
  const id = req.params.id;
  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization');
    }
    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    const properties = await Property.find({ userId: user._id });
    res.render('addUnit', { id, properties, csrfToken: req.csrfToken() });
  } catch (error) {
    console.error('Error rendering add unit:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/editunit/:id', authenticateJWT, async (req, res) => {
  const id = req.params.id;
  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization');
    }
    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    const units = await Unit.find({ userId: user._id });
    const properties = await Property.find({ userId: user._id });
    res.render('editUnit', { id, units, properties, csrfToken: req.csrfToken() });
  } catch (error) {
    console.error('Error rendering edit unit:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/addtenant/:id', authenticateJWT, async (req, res) => {
  const id = req.params.id;
  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization');
    }
    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    const properties = await Property.find({ userId: user._id });
    const units = await Unit.find({ userId: user._id });
    res.render('addTenant', { id, properties, units, csrfToken: req.csrfToken() });
  } catch (error) {
    console.error('Error rendering add tenant:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/edittenant/:id', authenticateJWT, async (req, res) => {
  const id = req.params.id;
  const tenantId = req.query.tenantId;
  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization');
    }
    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    const tenant = await Tenant.findOne({ _id: tenantId, userId: user._id });
    if (!tenant) return res.status(404).send('Tenant not found');
    const properties = await Property.find({ userId: user._id });
    const units = await Unit.find({ userId: user._id });
    res.render('editTenant', { id, tenant, properties, units, csrfToken: req.csrfToken() });
  } catch (error) {
    console.error('Error rendering edit tenant:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/authorize/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).send('Authorization not found');
    res.sendFile(path.join(__dirname, 'public', 'otp.html'));
  } catch (error) {
    console.error('Error rendering OTP page:', error);
    res.status(500).send('Internal server error');
  }
});

// Start Server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});