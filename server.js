require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const path = require('path');
const axios = require('axios');
const multer = require('multer');
const cors = require('cors');
const s3 = require('./config/r2'); // Centralized R2 configuration
const checkAuthorization = require('./middleware/auth'); // Centralized auth middleware

// Models
const Tenant = require('./models/Tenant');
const Property = require('./models/Property');
const User = require('./models/User');
const Authorize = require('./models/Authorize');
const Unit = require('./models/Unit');
const Otp = require('./models/Otp');

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// MongoDB connection with error handling
mongoose.set('strictQuery', false);
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('MongoDB connected'))
  .catch(error => {
    console.error('MongoDB connection error:', error);
    process.exit(1); // Exit if connection fails
  });

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected. Attempting to reconnect...');
  mongoose.connect(process.env.MONGODB_URI);
});

// Middleware setup
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-very-long-random-secret', // Ensure this is set in .env
  resave: false,
  saveUninitialized: true,
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
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter for signup
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: 'Too many signup attempts. Try again later.',
});

// Multer configuration with file type validation
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (extname && mimetype) return cb(null, true);
    cb(new Error('Only JPEG, JPG, and PNG images are allowed!'));
  },
});

// Import webhook routes
const { router: webhookRouter, sendMessage } = require('./routes/webhook');
app.use('/webhook', webhookRouter);

// Helper function to generate tenant ID
function generateTenantId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return 'T' + digits + letter;
}

// Helper function to generate OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper function to send OTP via WhatsApp
async function sendOTP(phoneNumber, otp) {
  try {
    await axios.post(process.env.WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'text',
      text: { body: `Your OTP for authorization is: ${otp}` },
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`OTP ${otp} sent to ${phoneNumber}`);
  } catch (error) {
    console.error('Error sending OTP:', error.response?.data || error.message);
    throw error;
  }
}

// Routes

// Add Property
app.post('/addproperty/:id', checkAuthorization, upload.single('image'), async (req, res) => {
  const { property_name, units, address, totalAmount } = req.body;

  try {
    const propertyData = {
      name: property_name,
      units,
      address,
      totalAmount,
      userId: req.user._id,
      images: [],
    };

    if (req.file) {
      const key = `images/${Date.now()}-${req.file.originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }).promise();
      propertyData.images.push(key);
    }

    const property = await new Property(propertyData).save();
    await sendMessage(req.authorizeRecord.phoneNumber, `Property *${property_name}* has been successfully added.`);
    await Authorize.findByIdAndDelete(req.params.id);

    res.json({ message: 'Property added successfully!' });
  } catch (error) {
    console.error('Error adding property:', error);
    res.status(500).json({ error: 'An error occurred while adding the property.' });
  }
});

// Add Unit
app.post('/addunit/:id', checkAuthorization, upload.single('image'), async (req, res) => {
  const { unit_number, property, property_id, rent_amount, floor, size } = req.body;

  try {
    const propertyId = property || property_id;
    if (!propertyId) {
      return res.status(400).json({ error: 'Property ID is required.' });
    }

    const propertyDoc = await Property.findById(propertyId);
    if (!propertyDoc) {
      return res.status(404).json({ error: 'Property not found.' });
    }

    const unitData = {
      unitNumber: unit_number,
      property: propertyId,
      rentAmount: rent_amount,
      floor,
      size,
      images: [],
      userId: req.user._id,
    };

    if (req.file) {
      const key = `images/${Date.now()}-${req.file.originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }).promise();
      unitData.images.push(key);
    }

    const unit = await new Unit(unitData).save();
    await sendMessage(req.authorizeRecord.phoneNumber, `Unit *${unit_number}* has been successfully added to property *${propertyDoc.name}*.`);
    await Authorize.findByIdAndDelete(req.params.id);

    res.json({ message: 'Unit added successfully!' });
  } catch (error) {
    console.error('Error adding unit:', error);
    res.status(500).json({ error: 'An error occurred while adding the unit.' });
  }
});

// Add Tenant
app.post('/addtenant/:id', checkAuthorization, upload.fields([{ name: 'photo' }, { name: 'idProof' }]), async (req, res) => {
  const { name, phone_number, unit_id, property_name, lease_start, deposit, rent_amount, tenant_id, email } = req.body;

  try {
    const tenantData = {
      name,
      phoneNumber: phone_number,
      unitAssigned: unit_id || null,
      propertyName: property_name,
      lease_start: lease_start ? new Date(lease_start) : null,
      deposit,
      rent_amount,
      tenant_id: tenant_id || generateTenantId(),
      email,
      images: [],
      userId: req.user._id,
    };

    if (req.files['photo']) {
      const photoKey = `images/${Date.now()}-${req.files['photo'][0].originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: photoKey,
        Body: req.files['photo'][0].buffer,
        ContentType: req.files['photo'][0].mimetype,
      }).promise();
      tenantData.images.push(photoKey);
    }

    if (req.files['idProof']) {
      const idProofKey = `images/${Date.now()}-${req.files['idProof'][0].originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: idProofKey,
        Body: req.files['idProof'][0].buffer,
        ContentType: req.files['idProof'][0].mimetype,
      }).promise();
      tenantData.images.push(idProofKey);
      tenantData.idProof = idProofKey;
    }

    const tenant = await new Tenant(tenantData).save();
    await sendMessage(req.authorizeRecord.phoneNumber, `Tenant *${name}* has been successfully added.`);
    await Authorize.findByIdAndDelete(req.params.id);

    res.json({ message: 'Tenant added successfully!' });
  } catch (error) {
    console.error('Error adding tenant:', error);
    res.status(500).json({ error: 'An error occurred while adding the tenant.' });
  }
});

// Edit Property
app.post('/editproperty/:id', checkAuthorization, upload.single('image'), async (req, res) => {
  const { propertyId, property_name, units, address, totalAmount } = req.body;

  try {
    const property = await Property.findOne({ _id: propertyId, userId: req.user._id });
    if (!property) {
      return res.status(404).json({ error: 'Property not found or you do not have permission to edit it.' });
    }

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
      property.images = [key]; // Replace existing images
    }

    await property.save();
    await sendMessage(req.authorizeRecord.phoneNumber, `Property *${property_name}* has been successfully updated.`);
    await Authorize.findByIdAndDelete(req.params.id);

    res.json({ message: 'Property updated successfully!' });
  } catch (error) {
    console.error('Error updating property:', error);
    res.status(500).json({ error: 'Error updating property.' });
  }
});

// GET Edit Property Form
app.get('/editproperty/:id', checkAuthorization, async (req, res) => {
  try {
    const properties = await Property.find({ userId: req.user._id });
    if (!properties.length) {
      return res.status(404).send('No properties found to edit.');
    }
    res.render('editProperty', { id: req.params.id, properties });
  } catch (error) {
    console.error('Error rendering edit property form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

// Delete Property
app.post('/deleteproperty/:id', checkAuthorization, async (req, res) => {
  const { propertyId } = req.body;

  try {
    const property = await Property.findOneAndDelete({ _id: propertyId, userId: req.user._id });
    if (!property) {
      return res.status(404).json({ error: 'Property not found or you do not have permission to delete it.' });
    }

    await sendMessage(req.authorizeRecord.phoneNumber, `Property *${property.name}* has been successfully deleted.`);
    await Authorize.findByIdAndDelete(req.params.id);

    res.json({ message: 'Property deleted successfully!' });
  } catch (error) {
    console.error('Error deleting property:', error);
    res.status(500).json({ error: 'Error deleting property.' });
  }
});

// Edit Unit
app.post('/editunit/:id', checkAuthorization, upload.single('image'), async (req, res) => {
  const { unitId, property, unit_number, rent_amount, floor, size } = req.body;

  try {
    const unit = await Unit.findById(unitId).populate('property');
    if (!unit || unit.property.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Unit not found or you do not have permission to edit it.' });
    }

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
      unit.images = [key]; // Replace existing images
    }

    await unit.save();
    const propertyDoc = await Property.findById(property);
    await sendMessage(req.authorizeRecord.phoneNumber, `Unit *${unit_number}* in property *${propertyDoc ? propertyDoc.name : 'Unknown'}* has been updated.`);
    await Authorize.findByIdAndDelete(req.params.id);

    res.json({ message: 'Unit updated successfully!' });
  } catch (error) {
    console.error('Error updating unit:', error);
    res.status(500).json({ error: 'Error updating unit.' });
  }
});

// Delete Unit
app.post('/deleteunit/:id', checkAuthorization, async (req, res) => {
  const { unitId } = req.body;

  try {
    const unit = await Unit.findOneAndDelete({ _id: unitId, userId: req.user._id });
    if (!unit) {
      return res.status(404).json({ error: 'Unit not found or you do not have permission to delete it.' });
    }

    await sendMessage(req.authorizeRecord.phoneNumber, `Unit *${unit.unitNumber}* has been successfully deleted.`);
    await Authorize.findByIdAndDelete(req.params.id);

    res.json({ message: 'Unit deleted successfully!' });
  } catch (error) {
    console.error('Error deleting unit:', error);
    res.status(500).json({ error: 'Error deleting unit.' });
  }
});

// Edit Tenant
app.post('/edittenant/:id', checkAuthorization, upload.fields([{ name: 'photo' }, { name: 'idProof' }]), async (req, res) => {
  const { tenantId, name, propertyName, unitAssigned, lease_start, deposit, rent_amount } = req.body;

  try {
    const tenant = await Tenant.findOne({ _id: tenantId, userId: req.user._id });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found or you do not have permission to edit it.' });
    }

    const unit = await Unit.findById(unitAssigned);
    if (!unit) {
      return res.status(400).json({ error: `No unit found with ID: ${unitAssigned}` });
    }

    tenant.name = name;
    tenant.propertyName = propertyName;
    tenant.unitAssigned = unit._id;
    tenant.lease_start = new Date(lease_start);
    tenant.deposit = deposit;
    tenant.rent_amount = rent_amount;

    if (req.files['photo']) {
      const photoKey = `images/${Date.now()}-${req.files['photo'][0].originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: photoKey,
        Body: req.files['photo'][0].buffer,
        ContentType: req.files['photo'][0].mimetype,
      }).promise();
      tenant.images[0] = photoKey; // Replace photo if exists
    }

    if (req.files['idProof']) {
      const idProofKey = `images/${Date.now()}-${req.files['idProof'][0].originalname}`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: idProofKey,
        Body: req.files['idProof'][0].buffer,
        ContentType: req.files['idProof'][0].mimetype,
      }).promise();
      tenant.idProof = idProofKey;
      tenant.images[1] = idProofKey; // Replace ID proof if exists
    }

    await tenant.save();
    await sendMessage(req.authorizeRecord.phoneNumber, `Tenant *${name}* edited successfully!`);
    await Authorize.findByIdAndDelete(req.params.id);

    res.json({ message: 'Tenant updated successfully!' });
  } catch (error) {
    console.error('Error updating tenant:', error);
    res.status(500).json({ error: 'Error updating tenant.' });
  }
});

// OTP Routes
app.get('/request-otp/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).json({ error: 'Authorization record not found.' });
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const otp = generateOTP();

    await Otp.findOneAndUpdate(
      { phoneNumber },
      { otp, attempts: 0, lastAttempt: null, validated: false, expiresAt: new Date(Date.now() + 15 * 60 * 1000) },
      { upsert: true, new: true }
    );

    req.session.phoneNumber = phoneNumber;
    await sendOTP(phoneNumber, otp);
    res.json({ status: 'OTP sent', phoneNumber });
  } catch (error) {
    console.error('Error requesting OTP:', error);
    res.status(500).json({ error: 'An error occurred while generating OTP.' });
  }
});

app.post('/validate-otp/:id', async (req, res) => {
  const id = req.params.id;
  const { otp } = req.body;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).json({ error: 'Authorization record not found.' });
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const otpDoc = await Otp.findOne({ phoneNumber });
    if (!otpDoc || otpDoc.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'OTP expired or not requested.' });
    }

    if (otpDoc.attempts >= 3 && Date.now() - otpDoc.lastAttempt < 180000) {
      return res.status(429).json({ error: 'Too many attempts. Try again after 3 minutes.' });
    }

    if (otp === otpDoc.otp) {
      otpDoc.validated = true;
      await otpDoc.save();

      const redirectUrl = authorizeRecord.action === 'edittenant' && req.query.tenantId
        ? `/edittenant/${id}?tenantId=${req.query.tenantId}`
        : `/${authorizeRecord.action}/${id}`;

      res.json({ status: 'OTP validated', redirect: redirectUrl });
    } else {
      otpDoc.attempts += 1;
      otpDoc.lastAttempt = new Date();
      await otpDoc.save();
      res.status(400).json({ error: 'Invalid OTP.' });
    }
  } catch (error) {
    console.error('Error validating OTP:', error);
    res.status(500).json({ error: 'An error occurred while validating OTP.' });
  }
});

// Middleware to check OTP validation
function checkOTPValidation(req, res, next) {
  const id = req.params.id;
  const phoneNumber = req.session.phoneNumber;

  if (!phoneNumber) {
    return res.status(401).json({ error: 'OTP not requested. Please request an OTP first.' });
  }

  Otp.findOne({ phoneNumber })
    .then(otpDoc => {
      if (!otpDoc || !otpDoc.validated) {
        return res.status(401).json({ error: 'OTP not validated. Please validate the OTP first.' });
      }
      next();
    })
    .catch(error => {
      console.error('Error checking OTP validation:', error);
      res.status(500).json({ error: 'An error occurred while checking OTP validation.' });
    });
}

// Authorization Page
app.get('/authorize/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }
    res.sendFile(path.join(__dirname, 'public', 'otp.html'));
  } catch (error) {
    console.error('Error rendering OTP page:', error);
    res.status(500).send('An error occurred while rendering the OTP page.');
  }
});

// Render Forms
app.get('/addproperty/:id', checkOTPValidation, checkAuthorization, async (req, res) => {
  res.render('addProperty', { id: req.params.id });
});

app.get('/removeproperty/:id', checkOTPValidation, checkAuthorization, async (req, res) => {
  try {
    const properties = await Property.find({ userId: req.user._id });
    if (!properties.length) {
      return res.status(404).send('No properties found to remove.');
    }
    res.render('removeProperty', { id: req.params.id, properties });
  } catch (error) {
    console.error('Error rendering remove property form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.get('/removeunit/:id', checkOTPValidation, checkAuthorization, async (req, res) => {
  try {
    const properties = await Property.find({ userId: req.user._id });
    const units = await Unit.find({ userId: req.user._id });
    if (!units.length) {
      return res.status(404).send('No units found to remove.');
    }
    res.render('removeUnit', { id: req.params.id, units, properties });
  } catch (error) {
    console.error('Error rendering remove unit form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.get('/addunit/:id', checkOTPValidation, checkAuthorization, async (req, res) => {
  try {
    const properties = await Property.find({ userId: req.user._id });
    if (!properties.length) {
      return res.status(404).send('No properties found. Please add a property first.');
    }
    res.render('addUnit', { id: req.params.id, properties });
  } catch (error) {
    console.error('Error rendering add unit form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.get('/editunit/:id', checkOTPValidation, checkAuthorization, async (req, res) => {
  try {
    const properties = await Property.find({ userId: req.user._id });
    const propertyIds = properties.map(p => p._id);
    const units = await Unit.find({ property: { $in: propertyIds } });
    if (!units.length) {
      return res.status(404).send('No units found to edit.');
    }
    res.render('editUnit', { id: req.params.id, units, properties });
  } catch (error) {
    console.error('Error rendering edit unit form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.get('/addtenant/:id', checkOTPValidation, checkAuthorization, async (req, res) => {
  try {
    const properties = await Property.find({ userId: req.user._id });
    const units = await Unit.find({ userId: req.user._id });
    if (!properties.length || !units.length) {
      return res.status(404).send('No properties or units found. Please add them first.');
    }
    res.render('addTenant', { id: req.params.id, properties, units });
  } catch (error) {
    console.error('Error rendering add tenant form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.get('/edittenant/:id', checkOTPValidation, checkAuthorization, async (req, res) => {
  const tenantId = req.query.tenantId;

  try {
    if (!tenantId || !mongoose.Types.ObjectId.isValid(tenantId)) {
      return res.status(400).send('Invalid or missing tenantId.');
    }

    const tenant = await Tenant.findOne({ _id: tenantId, userId: req.user._id });
    if (!tenant) {
      return res.status(404).send('Tenant not found or invalid tenantId.');
    }

    const properties = await Property.find({ userId: req.user._id });
    const units = await Unit.find({ userId: req.user._id });

    res.render('editTenant', { id: req.params.id, tenant, properties, units });
  } catch (error) {
    console.error('Error rendering edit tenant form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});