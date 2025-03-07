require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const csurf = require('csurf');
const path = require('path');
const axios = require('axios');
const multer = require('multer');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const crypto = require('crypto');
const Tenant = require('./models/Tenant');
const Image = require('./models/Image');
const Property = require('./models/Property');
const User = require('./models/User');
const Authorize = require('./models/Authorize');
const Unit = require('./models/Unit');
const Otp = require('./models/Otp');
const AWS = require('aws-sdk');

const app = express();
const port = process.env.PORT || 3000;

// Configure S3 client for Cloudflare R2
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  Bucket: process.env.R2_BUCKET,
  region: 'auto',
  signatureVersion: 'v4',
});

// Trust Glitch's proxy
app.set('trust proxy', 1);

// Set up EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Secure middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}));
app.use(mongoSanitize());
app.use(xss());

// Body parsing with limits
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

// MongoDB connection with security options
mongoose.set('strictQuery', true);
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
}).then(() => console.log('MongoDB connected'))
  .catch(error => console.error('MongoDB connection error:', error));

// Session setup with secure options
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions',
    ttl: 3600,
    autoRemove: 'native',
  }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 3600000,
    sameSite: 'strict',
  },
}));

// CORS with strict origin
const cors = require('cors');
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://your-frontend-domain.com',
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiting for all routes
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
});
app.use(globalLimiter);

// CSRF protection (session-based)
const csrfProtection = csurf({ cookie: false });

// Serve static files securely
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: '1h',
}));

// Middleware to add CSRF token to responses for EJS templates
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/webhook')) {
    res.locals.csrfToken = req.csrfToken ? req.csrfToken() : null;
  }
  next();
});

// Multer with file type validation
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and GIF are allowed.'));
    }
  },
});

// Routes and webhook
const { router, sendMessage } = require('./routes/webhook');
app.use('/webhook', router);

// Secure OTP generation
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

// Secure tenant ID generation
function generateTenantId() {
  const digits = crypto.randomInt(1000, 9999);
  const letter = String.fromCharCode(65 + crypto.randomInt(0, 26));
  return `T${digits}${letter}`;
}

// Middleware to check OTP validation
function checkOTPValidation(req, res, next) {
  const id = req.params.id;
  const phoneNumber = req.session.phoneNumber;

  if (!phoneNumber || !mongoose.Types.ObjectId.isValid(id)) {
    return res.status(401).send('OTP not requested or invalid ID.');
  }

  const storedOTPData = req.app.locals.otpStore.get(phoneNumber);
  if (!storedOTPData || !storedOTPData.validated) {
    return res.status(401).send('OTP not validated.');
  }

  next();
}

// In-memory OTP store
app.locals.otpStore = new Map();

// Routes
app.post('/addproperty/:id', upload.single('image'), csrfProtection, async (req, res) => {
  const { property_name, units, address, totalAmount } = req.body;
  const id = req.params.id;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).send('Invalid ID.');
  }

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const property = new Property({
      name: property_name.slice(0, 100),
      units: Math.min(parseInt(units) || 0, 1000),
      address: address.slice(0, 500),
      totalAmount: parseFloat(totalAmount) || 0,
      userId: user._id,
    });
    await property.save();

    if (req.file) {
      const key = `images/${crypto.randomBytes(16).toString('hex')}-${req.file.originalname}`;
      const uploadParams = {
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ACL: 'private',
      };
      await s3.upload(uploadParams).promise();
      const imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
      const image = new Image({ propertyId: property._id, imageUrl });
      await image.save();
      property.images.push(image._id);
      await property.save();
    }

    await sendMessage(authorizeRecord.phoneNumber, `Property *${property_name}* added successfully.`);
    await Authorize.findByIdAndDelete(id);

    res.send('Property added successfully!');
  } catch (error) {
    console.error('Error adding property:', error);
    res.status(500).send('Server error.');
  }
});

app.post('/addunit/:id', upload.single('image'), csrfProtection, async (req, res) => {
  const { property, unit_number, rent_amount, floor, size } = req.body;
  const id = req.params.id;

  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(property)) {
    return res.status(400).send('Invalid ID.');
  }

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const unit = new Unit({
      property,
      unitNumber: unit_number.slice(0, 50),
      rentAmount: parseFloat(rent_amount) || 0,
      floor: parseInt(floor) || 0,
      size: parseFloat(size) || 0,
      userId: user._id,
    });
    await unit.save();

    if (req.file) {
      const key = `images/${crypto.randomBytes(16).toString('hex')}-${req.file.originalname}`;
      const uploadParams = {
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ACL: 'private',
      };
      await s3.upload(uploadParams).promise();
      const imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
      const image = new Image({ unitId: unit._id, imageUrl });
      await image.save();
      unit.images.push(image._id);
      await unit.save();
    }

    const propertyDoc = await Property.findById(property);
    await sendMessage(authorizeRecord.phoneNumber, `Unit "${unit_number}" added to "${propertyDoc?.name || 'Unknown'}".`);
    await Authorize.findByIdAndDelete(id);

    res.send('Unit added successfully!');
  } catch (error) {
    console.error('Error adding unit:', error);
    res.status(500).send('Server error.');
  }
});

app.post('/addtenant/:id', upload.fields([{ name: 'photo' }, { name: 'idProof' }]), csrfProtection, async (req, res) => {
  const { name, propertyName, unitAssigned, lease_start, deposit, rent_amount, tenant_id } = req.body;
  const id = req.params.id;

  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(unitAssigned)) {
    return res.status(400).send('Invalid ID.');
  }

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const unit = await Unit.findById(unitAssigned);
    if (!unit) {
      return res.status(400).send('Unit not found.');
    }

    const tenant = new Tenant({
      name: name.slice(0, 100),
      phoneNumber: user.phoneNumber,
      userId: user._id,
      propertyName: propertyName.slice(0, 100),
      unitAssigned: unit._id,
      lease_start: new Date(lease_start),
      deposit: parseFloat(deposit) || 0,
      rent_amount: parseFloat(rent_amount) || 0,
      tenant_id: tenant_id || generateTenantId(),
    });

    if (req.files.photo) {
      const key = `images/${crypto.randomBytes(16).toString('hex')}-${req.files.photo[0].originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.files.photo[0].buffer,
        ContentType: req.files.photo[0].mimetype,
        ACL: 'private',
      }).promise();
      tenant.photo = `${process.env.R2_PUBLIC_URL}/${key}`;
    }

    if (req.files.idProof) {
      const key = `images/${crypto.randomBytes(16).toString('hex')}-${req.files.idProof[0].originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.files.idProof[0].buffer,
        ContentType: req.files.idProof[0].mimetype,
        ACL: 'private',
      }).promise();
      tenant.idProof = `${process.env.R2_PUBLIC_URL}/${key}`;
    }

    await tenant.save();
    await sendMessage(authorizeRecord.phoneNumber, `Tenant "${name}" added to unit "${unit.unitNumber}".`);
    await Authorize.findByIdAndDelete(id);

    res.send('Tenant added successfully!');
  } catch (error) {
    console.error('Error adding tenant:', error);
    res.status(500).send('Server error.');
  }
});

app.post('/editproperty/:id', upload.single('image'), csrfProtection, async (req, res) => {
  const { propertyId, property_name, units, address, totalAmount } = req.body;
  const id = req.params.id;

  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(propertyId)) {
    return res.status(400).send('Invalid ID.');
  }

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const property = await Property.findOne({ _id: propertyId, userId: user._id });
    if (!property) {
      return res.status(404).send('Property not found.');
    }

    property.name = property_name.slice(0, 100);
    property.units = Math.min(parseInt(units) || 0, 1000);
    property.address = address.slice(0, 500);
    property.totalAmount = parseFloat(totalAmount) || 0;

    if (req.file) {
      const key = `images/${crypto.randomBytes(16).toString('hex')}-${req.file.originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ACL: 'private',
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
    await sendMessage(authorizeRecord.phoneNumber, `Property "${property_name}" updated successfully.`);
    await Authorize.findByIdAndDelete(id);

    res.send('Property updated successfully!');
  } catch (error) {
    console.error('Error updating property:', error);
    res.status(500).send('Server error.');
  }
});

app.get('/editproperty/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const properties = await Property.find({ userId: user._id });
    if (!properties.length) {
      return res.status(404).send('No properties found.');
    }

    res.render('editProperty', { id, properties });
  } catch (error) {
    console.error('Error rendering edit property:', error);
    res.status(500).send('Server error.');
  }
});

app.post('/deleteproperty/:id', checkOTPValidation, csrfProtection, async (req, res) => {
  const { propertyId } = req.body;
  const id = req.params.id;

  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(propertyId)) {
    return res.status(400).send('Invalid ID.');
  }

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const property = await Property.findOneAndDelete({ _id: propertyId, userId: user._id });
    if (!property) {
      return res.status(404).send('Property not found.');
    }

    await sendMessage(authorizeRecord.phoneNumber, `Property "${property.name}" deleted successfully.`);
    await Authorize.findByIdAndDelete(id);

    res.send('Property deleted successfully!');
  } catch (error) {
    console.error('Error deleting property:', error);
    res.status(500).send('Server error.');
  }
});

app.post('/editunit/:id', upload.single('image'), csrfProtection, async (req, res) => {
  const { unitId, property, unit_number, rent_amount, floor, size } = req.body;
  const id = req.params.id;

  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(unitId) || !mongoose.Types.ObjectId.isValid(property)) {
    return res.status(400).send('Invalid ID.');
  }

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const unit = await Unit.findOne({ _id: unitId, userId: user._id });
    if (!unit) {
      return res.status(404).send('Unit not found.');
    }

    unit.property = property;
    unit.unitNumber = unit_number.slice(0, 50);
    unit.rentAmount = parseFloat(rent_amount) || 0;
    unit.floor = parseInt(floor) || 0;
    unit.size = parseFloat(size) || 0;

    if (req.file) {
      const key = `images/${crypto.randomBytes(16).toString('hex')}-${req.file.originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ACL: 'private',
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
    await sendMessage(authorizeRecord.phoneNumber, `Unit "${unit_number}" in "${propertyDoc?.name || 'Unknown'}" updated.`);
    await Authorize.findByIdAndDelete(id);

    res.send('Unit updated successfully!');
  } catch (error) {
    console.error('Error updating unit:', error);
    res.status(500).send('Server error.');
  }
});

app.post('/deleteunit/:id', checkOTPValidation, csrfProtection, async (req, res) => {
  const { unitId } = req.body;
  const id = req.params.id;

  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(unitId)) {
    return res.status(400).send('Invalid ID.');
  }

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const unit = await Unit.findOneAndDelete({ _id: unitId, userId: user._id });
    if (!unit) {
      return res.status(404).send('Unit not found.');
    }

    await sendMessage(authorizeRecord.phoneNumber, `Unit "${unit.unitNumber}" deleted successfully.`);
    await Authorize.findByIdAndDelete(id);

    res.send('Unit deleted successfully!');
  } catch (error) {
    console.error('Error deleting unit:', error);
    res.status(500).send('Server error.');
  }
});

app.post('/edittenant/:id', upload.fields([{ name: 'photo' }, { name: 'idProof' }]), csrfProtection, async (req, res) => {
  const { tenantId, name, propertyName, unitAssigned, lease_start, deposit, rent_amount } = req.body;
  const id = req.params.id;

  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(tenantId) || !mongoose.Types.ObjectId.isValid(unitAssigned)) {
    return res.status(400).send('Invalid ID.');
  }

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const tenant = await Tenant.findOne({ _id: tenantId, userId: user._id });
    if (!tenant) {
      return res.status(404).send('Tenant not found.');
    }

    const unit = await Unit.findById(unitAssigned);
    if (!unit) {
      return res.status(400).send('Unit not found.');
    }

    tenant.name = name.slice(0, 100);
    tenant.propertyName = propertyName.slice(0, 100);
    tenant.unitAssigned = unit._id;
    tenant.lease_start = new Date(lease_start);
    tenant.deposit = parseFloat(deposit) || 0;
    tenant.rent_amount = parseFloat(rent_amount) || 0;

    if (req.files.photo) {
      const key = `images/${crypto.randomBytes(16).toString('hex')}-${req.files.photo[0].originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.files.photo[0].buffer,
        ContentType: req.files.photo[0].mimetype,
        ACL: 'private',
      }).promise();
      tenant.photo = `${process.env.R2_PUBLIC_URL}/${key}`;
    }

    if (req.files.idProof) {
      const key = `images/${crypto.randomBytes(16).toString('hex')}-${req.files.idProof[0].originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.files.idProof[0].buffer,
        ContentType: req.files.idProof[0].mimetype,
        ACL: 'private',
      }).promise();
      tenant.idProof = `${process.env.R2_PUBLIC_URL}/${key}`;
    }

    await tenant.save();
    await sendMessage(authorizeRecord.phoneNumber, `Tenant "${name}" updated successfully.`);
    await Authorize.findByIdAndDelete(id);

    res.send('Tenant updated successfully!');
  } catch (error) {
    console.error('Error updating tenant:', error);
    res.status(500).send('Server error.');
  }
});

app.get('/request-otp/:id', async (req, res) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).send('Invalid ID.');
  }

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization not found.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const otp = generateOTP();
    const expiresAt = Date.now() + 5 * 60 * 1000;

    app.locals.otpStore.set(phoneNumber, { otp, attempts: 0, lastAttempt: null, validated: false, expiresAt });
    req.session.phoneNumber = phoneNumber;

    await sendMessage(phoneNumber, `Your OTP is: ${otp}`);
    res.json({ status: 'OTP sent', phoneNumber });
  } catch (error) {
    console.error('Error requesting OTP:', error);
    res.status(500).send('Server error.');
  }
});

app.post('/validate-otp/:id', csrfProtection, async (req, res) => {
  const id = req.params.id;
  const { otp } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id) || !/^\d{6}$/.test(otp)) {
    return res.status(400).send('Invalid ID or OTP.');
  }

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization not found.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const storedOTPData = app.locals.otpStore.get(phoneNumber);

    if (!storedOTPData || storedOTPData.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'OTP expired or not requested.' });
    }

    if (storedOTPData.attempts >= 3 && Date.now() - storedOTPData.lastAttempt < 180000) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }

    if (otp === storedOTPData.otp) {
      app.locals.otpStore.set(phoneNumber, { ...storedOTPData, validated: true });
      const redirectUrl = `/authorize/${id}`;
      res.json({ status: 'OTP validated', redirect: redirectUrl });
    } else {
      app.locals.otpStore.set(phoneNumber, { ...storedOTPData, attempts: storedOTPData.attempts + 1, lastAttempt: Date.now() });
      res.status(400).json({ error: 'Invalid OTP.' });
    }
  } catch (error) {
    console.error('Error validating OTP:', error);
    res.status(500).send('Server error.');
  }
});

app.get('/authorize/:id', async (req, res) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).send('Invalid ID.');
  }

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization not found.');
    }

    res.sendFile(path.join(__dirname, 'public', 'otp.html'));
  } catch (error) {
    console.error('Error rendering OTP page:', error);
    res.status(500).send('Server error.');
  }
});

app.get('/addproperty/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    res.render('addProperty', { id });
  } catch (error) {
    console.error('Error rendering add property:', error);
    res.status(500).send('Server error.');
  }
});

app.get('/removeproperty/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const properties = await Property.find({ userId: user._id });
    if (!properties.length) {
      return res.status(404).send('No properties found.');
    }

    res.render('removeProperty', { id, properties });
  } catch (error) {
    console.error('Error rendering remove property:', error);
    res.status(500).send('Server error.');
  }
});

app.get('/removeunit/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const units = await Unit.find({ userId: user._id });
    const properties = await Property.find({ userId: user._id });
    if (!units.length) {
      return res.status(404).send('No units found.');
    }

    res.render('removeUnit', { id, units, properties });
  } catch (error) {
    console.error('Error rendering remove unit:', error);
    res.status(500).send('Server error.');
  }
});

app.get('/removetenant/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const tenants = await Tenant.find({ userId: user._id });
    if (!tenants.length) {
      return res.status(404).send('No tenants found.');
    }

    res.render('removeTenant', { id, tenants });
  } catch (error) {
    console.error('Error rendering remove tenant:', error);
    res.status(500).send('Server error.');
  }
});

app.get('/addunit/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const properties = await Property.find({ userId: user._id });
    if (!properties.length) {
      return res.status(404).send('No properties found.');
    }

    res.render('addUnit', { id, properties });
  } catch (error) {
    console.error('Error rendering add unit:', error);
    res.status(500).send('Server error.');
  }
});

app.get('/editunit/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const units = await Unit.find({ userId: user._id });
    const properties = await Property.find({ userId: user._id });
    if (!units.length) {
      return res.status(404).send('No units found.');
    }

    res.render('editUnit', { id, units, properties });
  } catch (error) {
    console.error('Error rendering edit unit:', error);
    res.status(500).send('Server error.');
  }
});

app.get('/addtenant/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const properties = await Property.find({ userId: user._id });
    const units = await Unit.find({ userId: user._id });
    if (!properties.length || !units.length) {
      return res.status(404).send('No properties or units found.');
    }

    res.render('addTenant', { id, properties, units });
  } catch (error) {
    console.error('Error rendering add tenant:', error);
    res.status(500).send('Server error.');
  }
});

app.get('/edittenant/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;
  const tenantId = req.query.tenantId;

  if (!mongoose.Types.ObjectId.isValid(id) || (tenantId && !mongoose.Types.ObjectId.isValid(tenantId))) {
    return res.status(400).send('Invalid ID.');
  }

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord || authorizeRecord.used) {
      return res.status(403).send('Invalid or used authorization.');
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const tenant = tenantId ? await Tenant.findOne({ _id: tenantId, userId: user._id }) : null;
    if (tenantId && !tenant) {
      return res.status(404).send('Tenant not found.');
    }

    const properties = await Property.find({ userId: user._id });
    const units = await Unit.find({ userId: user._id });

    res.render('editTenant', { id, tenant, properties, units });
  } catch (error) {
    console.error('Error rendering edit tenant:', error);
    res.status(500).send('Server error.');
  }
});

// Error handling for CSRF
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    console.error('CSRF Token Error:', err);
    return res.status(403).send('Invalid CSRF token.');
  }
  next(err);
});

// Start server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});