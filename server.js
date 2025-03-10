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
const Property = require('./models/Property');
const User = require('./models/User');
const Authorize = require('./models/Authorize');
const Unit = require('./models/Unit');

const app = express();
const port = process.env.PORT || 3000;
const AWS = require('aws-sdk');

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

const { router, waitForUserResponse, userResponses, sendMessage } = require('./routes/webhook');
app.use('/webhook', router);

async function sendWhatsAppAuthMessage(phoneNumber) {
    return axios.post(process.env.WHATSAPP_API_URL, {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: 'Do you authorize this action?' },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'Yes_authorize', title: 'Yes' } },
                    { type: 'reply', reply: { id: 'No_authorize', title: 'No' } }
                ]
            }
        }
    }, {
        headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        },
    });
}

// Property Routes
app.post('/addproperty/:id', upload.single('image'), async (req, res) => {
  const { property_name, units, address, totalAmount } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).send('Authorization record not found.');
    if (authorizeRecord.used) return res.status(403).send('This link has already been used.');

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(404).send('User not found.');

    const propertyData = {
      name: property_name,
      units,
      address,
      totalAmount,
      userId: user._id,
      images: [],
    };

    if (req.file) {
      const key = 'images/' + Date.now() + '-' + req.file.originalname;
      const uploadParams = {
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      };
      await s3.upload(uploadParams).promise();
      propertyData.images.push(key);
    }

    const property = new Property(propertyData);
    await property.save();
    await sendMessage(authorizeRecord.phoneNumber, `Property *${property_name}* has been successfully added.`);
    await Authorize.findByIdAndDelete(id);
    res.send('Property added successfully!');
  } catch (error) {
    console.error('Error adding property:', error);
    res.status(500).send('An error occurred while adding the property.');
  }
});

app.post('/editproperty/:id', upload.single('image'), async (req, res) => {
    const { propertyId, property_name, units, address, totalAmount } = req.body;
    const id = req.params.id;

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) return res.status(404).send('Authorization record not found.');
        if (authorizeRecord.used) return res.status(403).send('This link has already been used.');

        const phoneNumber = authorizeRecord.phoneNumber;
        const user = await User.findOne({ phoneNumber });
        if (!user) return res.status(404).send('User not found.');

        const property = await Property.findOne({ _id: propertyId, userId: user._id });
        if (!property) return res.status(404).send('Property not found or you do not have permission to edit it.');

        property.name = property_name;
        property.units = units;
        property.address = address;
        property.totalAmount = totalAmount;

        if (req.file) {
            const key = 'images/' + Date.now() + '-' + req.file.originalname;
            const uploadParams = {
                Bucket: process.env.R2_BUCKET,
                Key: key,
                Body: req.file.buffer,
                ContentType: req.file.mimetype,
            };
            await s3.upload(uploadParams).promise();
            property.images = [key];
        }

        await property.save();
        await sendMessage(phoneNumber, `Property "${property_name}" has been successfully updated.`);
        await Authorize.findByIdAndDelete(id);
        res.send('Property updated successfully!');
    } catch (error) {
        console.error('Error updating property:', error);
        res.status(500).send('Error updating property.');
    }
});

app.get('/editproperty/:id', checkOTPValidation, async (req, res) => {
    const id = req.params.id;

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) return res.status(404).send('Authorization record not found.');
        if (authorizeRecord.used) return res.status(403).send('This link has already been used.');

        const phoneNumber = authorizeRecord.phoneNumber;
        const user = await User.findOne({ phoneNumber });
        if (!user) return res.status(404).send('User not found.');

        const properties = await Property.find({ userId: user._id });
        if (!properties.length) return res.status(404).send('No properties found to edit.');

        res.render('editProperty', { id, properties });
    } catch (error) {
        console.error('Error rendering edit property form:', error);
        res.status(500).send('An error occurred while rendering the form.');
    }
});

app.post('/deleteproperty/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;
  const { propertyId } = req.body;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).send('Authorization record not found.');
    if (authorizeRecord.used) return res.status(403).send('This link has already been used.');

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(404).send('User not found.');

    const property = await Property.findOneAndDelete({
      _id: propertyId,
      userId: user._id,
    });
    if (!property) return res.status(404).send('Property not found or you do not have permission to delete it.');

    await sendMessage(phoneNumber, `Property "${property.name}" has been successfully deleted.`);
    await Authorize.findByIdAndDelete(id);
    res.send('Property deleted successfully!');
  } catch (error) {
    console.error('Error deleting property:', error);
    res.status(500).send('Error deleting property.');
  }
});

// Unit Routes
app.post('/deleteunit/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;
  const { unitId } = req.body;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).send('Authorization record not found.');
    if (authorizeRecord.used) return res.status(403).send('This link has already been used.');

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(404).send('User not found.');

    const unit = await Unit.findOneAndDelete({ _id: unitId, userId: user._id });
    if (!unit) return res.status(404).send('Unit not found or you do not have permission to delete it.');

    await sendMessage(phoneNumber, `Unit "${unit.unitNumber}" has been successfully deleted.`);
    await Authorize.findByIdAndDelete(id);
    res.send('Unit deleted successfully!');
  } catch (error) {
    console.error('Error deleting unit:', error);
    res.status(500).send('Error deleting unit.');
  }
});

// Tenant Routes
app.post('/addtenant/:id', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'idProof', maxCount: 1 }]), async (req, res) => {
  const { name, phone_number, unit_id, property_name, lease_start, deposit, rent_amount, tenant_id, email } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).send('Authorization record not found.');
    if (authorizeRecord.used) return res.status(403).send('This link has already been used.');

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(404).send('User not found.');

    const tenantData = {
      name,
      phoneNumber: phone_number,
      unitAssigned: unit_id || null,
      propertyName: property_name,
      lease_start: lease_start ? new Date(lease_start) : null,
      deposit,
      rent_amount,
      tenant_id,
      email,
      images: [],
    };

    if (req.files['photo']) {
      const photoKey = 'images/' + Date.now() + '-' + req.files['photo'][0].originalname;
      const photoParams = {
        Bucket: process.env.R2_BUCKET,
        Key: photoKey,
        Body: req.files['photo'][0].buffer,
        ContentType: req.files['photo'][0].mimetype,
      };
      await s3.upload(photoParams).promise();
      tenantData.images.push(photoKey);
    }

    if (req.files['idProof']) {
      const idProofKey = 'images/' + Date.now() + '-' + req.files['idProof'][0].originalname;
      const idProofParams = {
        Bucket: process.env.R2_BUCKET,
        Key: idProofKey,
        Body: req.files['idProof'][0].buffer,
        ContentType: req.files['idProof'][0].mimetype,
      };
      await s3.upload(idProofParams).promise();
      tenantData.images.push(idProofKey);
      tenantData.idProof = idProofKey;
    }

    const tenant = new Tenant(tenantData);
    await tenant.save();
    await sendMessage(phoneNumber, `Tenant *${name}* has been successfully added.`);
    await Authorize.findByIdAndDelete(id);
    res.send('Tenant added successfully!');
  } catch (error) {
    console.error('Error adding tenant:', error);
    res.status(500).send('An error occurred while adding the tenant.');
  }
});

app.post('/edittenant/:id', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'idProof', maxCount: 1 }]), async (req, res) => {
  const { tenantId, name, propertyName, unitAssigned, lease_start, deposit, rent_amount } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).send('Authorization record not found.');
    if (authorizeRecord.used) return res.status(403).send('This link has already been used.');

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(404).send('User not found.');

    const tenant = await Tenant.findOne({ _id: tenantId, userId: user._id });
    if (!tenant) return res.status(404).send('Tenant not found or you do not have permission to edit it.');

    const unit = await Unit.findById(unitAssigned);
    if (!unit) return res.status(400).send(`No unit found with ID: ${unitAssigned}`);

    tenant.name = name;
    tenant.propertyName = propertyName;
    tenant.unitAssigned = unit._id;
    tenant.lease_start = new Date(lease_start);
    tenant.deposit = deposit;
    tenant.rent_amount = rent_amount;

    if (req.files['photo']) {
      const photoKey = 'images/' + Date.now() + '-' + req.files['photo'][0].originalname;
      const photoParams = {
        Bucket: process.env.R2_BUCKET,
        Key: photoKey,
        Body: req.files['photo'][0].buffer,
        ContentType: req.files['photo'][0].mimetype,
      };
      await s3.upload(photoParams).promise();
      tenant.images[0] = photoKey;
    }
    if (req.files['idProof']) {
      const idProofKey = 'images/' + Date.now() + '-' + req.files['idProof'][0].originalname;
      const idProofParams = {
        Bucket: process.env.R2_BUCKET,
        Key: idProofKey,
        Body: req.files['idProof'][0].buffer,
        ContentType: req.files['idProof'][0].mimetype,
      };
      await s3.upload(idProofParams).promise();
      tenant.images[1] = idProofKey;
      tenant.idProof = idProofKey;
    }

    await tenant.save();
    await sendMessage(phoneNumber, `Tenant "${name}" edited successfully!`);
    await Authorize.findByIdAndDelete(id);
    res.send('Tenant updated successfully! Check WhatsApp for confirmation.');
  } catch (error) {
    console.error('Error updating tenant:', error);
    res.status(500).send('Error updating tenant.');
  }
});

app.get('/edittenant/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;
  const tenantId = req.query.tenantId;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).send('Authorization record not found.');
    if (authorizeRecord.used) return res.status(403).send('This link has already been used.');

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(404).send('User not found.');

    if (!tenantId || !mongoose.Types.ObjectId.isValid(tenantId)) return res.status(400).send('Invalid or missing tenantId.');

    const tenant = await Tenant.findOne({ _id: tenantId, userId: user._id });
    if (!tenant) return res.status(404).send('Tenant not found or invalid tenantId.');

    const properties = await Property.find({ userId: user._id });
    const units = await Unit.find({ userId: user._id });

    res.render('editTenant', { id, tenant, properties, units });
  } catch (error) {
    console.error('Error rendering edit tenant form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

// OTP Routes
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

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
  } catch (error) {
    console.error('Error sending OTP:', error.response ? error.response.data : error.message);
  }
}

const otpStore = new Map();

app.get('/request-otp/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).send('Authorization record not found.');

    const phoneNumber = authorizeRecord.phoneNumber;
    const otp = generateOTP();
    otpStore.set(phoneNumber, { otp, attempts: 0, lastAttempt: null, validated: false });
    req.session.phoneNumber = phoneNumber;
    await sendOTP(phoneNumber, otp);
    res.json({ status: 'OTP sent', phoneNumber });
  } catch (error) {
    console.error('Error in /request-otp/:id route:', error);
    res.status(500).send('An error occurred while generating OTP.');
  }
});

app.post('/validate-otp/:id', async (req, res) => {
  const id = req.params.id;
  const { otp } = req.body;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).send('Authorization record not found.');

    const phoneNumber = authorizeRecord.phoneNumber;
    const storedOTPData = otpStore.get(phoneNumber);

    if (!storedOTPData) return res.status(400).json({ error: 'OTP expired or not requested.' });

    const { otp: storedOTP, attempts, lastAttempt } = storedOTPData;

    if (attempts >= 3 && Date.now() - lastAttempt < 180000) {
      return res.status(429).json({ error: 'Too many attempts. Try again after 3 minutes.' });
    }

    if (otp === storedOTP) {
      otpStore.set(phoneNumber, { ...storedOTPData, validated: true });
      let redirectUrl;
      switch (authorizeRecord.action) {
        case 'edittenant':
          redirectUrl = tenantId ? `/edittenant/${id}?tenantId=${tenantId}` : `/edittenant/${id}`;
          break;
        case 'addproperty':
          redirectUrl = `/addproperty/${id}`;
          break;
        case 'editproperty':
          redirectUrl = `/editproperty/${id}`;
          break;
        case 'addtenant':
          redirectUrl = `/addtenant/${id}`;
          break;
        default:
          redirectUrl = `/editproperty/${id}`;
      }
      res.json({ status: 'OTP validated', redirect: redirectUrl });
    } else {
      otpStore.set(phoneNumber, { ...storedOTPData, attempts: attempts + 1, lastAttempt: Date.now() });
      res.status(400).json({ error: 'Invalid OTP.' });
    }
  } catch (error) {
    console.error('Error validating OTP:', error);
    res.status(500).send('An error occurred while validating OTP.');
  }
});

app.get('/authorize/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).send('Authorization record not found.');
    res.sendFile(path.join(__dirname, 'public', 'otp.html'));
  } catch (error) {
    console.error('Error in /authorize/:id route:', error);
    res.status(500).send('An error occurred while rendering the OTP page.');
  }
});

function checkOTPValidation(req, res, next) {
  const id = req.params.id;
  const phoneNumber = req.session.phoneNumber;

  if (!phoneNumber) return res.status(401).send('OTP not requested. Please request an OTP first.');

  const storedOTPData = otpStore.get(phoneNumber);
  if (!storedOTPData || !storedOTPData.validated) return res.status(401).send('OTP not validated. Please validate the OTP first.');

  next();
}

app.get('/addproperty/:id', checkOTPValidation, async (req, res) => {
    const id = req.params.id;
    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) return res.status(404).send('Authorization record not found.');
        if (authorizeRecord.used) return res.status(403).send('This link has already been used.');
        res.render('addProperty', { id });
    } catch (error) {
        console.error('Error rendering add property form:', error);
        res.status(500).send('An error occurred while rendering the form.');
    }
});

app.get('/removeunit/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;
  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).send('Authorization record not found.');
    if (authorizeRecord.used) return res.status(403).send('This link has already been used.');

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(404).send('User not found.');

    const properties = await Property.find({ userId: user._id });
    if (!properties.length) return res.status(404).send('No properties found. Please add a property first.');

    const propertyIds = properties.map(p => p._id);
    const units = await Unit.find({ property: { $in: propertyIds } });
    if (!units.length) return res.status(404).send('No units found to remove.');

    res.render('removeUnit', { id, units, properties });
  } catch (error) {
    console.error('Error rendering remove unit form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.get('/addtenant/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;
  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) return res.status(404).send('Authorization record not found.');
    if (authorizeRecord.used) return res.status(403).send('This link has already been used.');

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(404).send('User not found.');

    const properties = await Property.find({ userId: user._id });
    const units = await Unit.find({ userId: user._id });
    if (!properties.length || !units.length) return res.status(404).send('No properties or units found. Please add them first.');

    res.render('addTenant', { id, properties, units });
  } catch (error) {
    console.error('Error rendering add tenant form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});