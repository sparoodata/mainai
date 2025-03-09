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
const Otp = require('./models/Otp');
const Dropbox = require('dropbox').Dropbox;
const fetch = require('isomorphic-fetch');

const app = express();
const port = process.env.PORT || 3000; // Glitch uses dynamic port
const AWS = require('aws-sdk');

// Configure the S3 client to use Cloudflare R2 settings
const { S3Client } = require('@aws-sdk/client-s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Configure R2 client

// Configure the S3 client to use Cloudflare R2 settings

// Configure the S3 client to use Cloudflare R2 settings
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});
// Trust the first proxy
app.set('trust proxy', 1);

// Set up EJS as the templating engine
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
    origin: 'http://your-frontend-domain.com', // Replace with your frontend domain
    credentials: true, // Allow cookies to be sent
}));
// Session setup with MongoDB storage
app.use(session({
    secret: process.env.SESSION_SECRET, // Ensure this is set in .env
    resave: false,
    saveUninitialized: true,
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI, // Ensure this is correct
        collectionName: 'sessions', // Optional: Name of the collection to store sessions
        ttl: 3600, // Session TTL (time to live) in seconds (1 hour)
    }),
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // Ensure cookies are only sent over HTTPS in production
        maxAge: 3600000, // 1 hour
    },
}));

// Serve static files (public directory)
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter for signup
const signupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: 'Too many signup attempts. Try again later.',
});

// Configure multer for image uploads (memory storage)
const storage = multer.memoryStorage(); // Use memory storage for direct upload to Dropbox
const upload = multer({ 
    storage: storage, 
    limits: { fileSize: 5 * 1024 * 1024 }, // Limit file size to 5 MB
});

// Routes and webhook handling
const { router, waitForUserResponse, userResponses, sendMessage } = require('./routes/webhook');
app.use('/webhook', router);




// Function to send WhatsApp message for authorization
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



function generateTenantId() {
    // Generate a random 4-digit number (ensuring it is always 4 digits)
    const digits = Math.floor(1000 + Math.random() * 9000);
    // Generate a random uppercase letter (A-Z)
    const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    return 'T' + digits + letter;
}


// Route to get units for a selected property

app.post('/addproperty/:id', upload.single('image'), async (req, res) => {
  const { property_name, units, address, totalAmount } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      console.error('Authorization record not found for ID:', id);
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      console.error('Authorization already used for ID:', id);
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      console.error('User not found for phoneNumber:', phoneNumber);
      return res.status(404).send('User not found.');
    }

    // Create the property with imageUrls array
    const propertyData = {
      name: property_name,
      units,
      address,
      totalAmount,
      userId: user._id,
      images: [], // Initialize as empty array
    };

    if (req.file) {
      const key = 'images/' + Date.now() + '-' + req.file.originalname;
      const uploadParams = {
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      };

      const uploadResult = await s3.upload(uploadParams).promise();
      console.log(`Uploaded image to R2 with key: ${key}`);
      propertyData.images.push(key); // Add the bucket path to the array
    }

    const property = new Property(propertyData);
    await property.save();
    console.log(`Property saved with ID: ${property._id} and images: ${JSON.stringify(property.imageUrls)}`);

    await sendMessage(authorizeRecord.phoneNumber, `Property *${property_name}* has been successfully added.`);
    console.log(`Confirmation message sent to ${authorizeRecord.phoneNumber}`);

    await Authorize.findByIdAndDelete(id);
    console.log(`Authorization record deleted for ID: ${id}`);

    res.send('Property added successfully!');
  } catch (error) {
    console.error('Error adding property:', error);
    res.status(500).send('An error occurred while adding the property.');
  }
});
// Handle form submission and image upload to Dropbox (add unit)
app.post('/addunit/:id', upload.single('image'), async (req, res) => {
  const { property, unit_number, rent_amount, floor, size } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const unit = new Unit({
      property,
      unitNumber: unit_number,
      rentAmount: rent_amount,
      floor,
      size,
      userId: user._id,
    });
    await unit.save();

    if (req.file) {
      const key = 'images/' + Date.now() + '-' + req.file.originalname;
      const uploadParams = {
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      };

      await s3.upload(uploadParams).promise();
      const imageUrl = process.env.R2_PUBLIC_URL + '/' + key;

      const image = new Image({ unitId: unit._id, imageUrl: imageUrl });
      await image.save();
      unit.images.push(image._id);
      await unit.save();
    }

    // Send WhatsApp confirmation
    const propertyDoc = await Property.findById(property);
    await sendMessage(
      phoneNumber,
      `Unit "${unit_number}" has been added to property "${propertyDoc ? propertyDoc.name : 'Unknown'}".`
    );

    // Mark authorization as used and delete it
    authorizeRecord.used = true;
    await authorizeRecord.save();
    await Authorize.findByIdAndDelete(id);

    res.send('Unit and image added successfully!');
  } catch (error) {
    console.error('Error adding unit and image:', error);
    res.status(500).send('An error occurred while adding the unit and image.');
  }
});

// Add tenant route that waits for WhatsApp authorization
app.post('/addtenant/:id', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'idProof', maxCount: 1 }]), async (req, res) => {
  const { name, propertyName, unitAssigned, lease_start, deposit, rent_amount, tenant_id } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    // Debug: Log the incoming unitAssigned value
    console.log('unitAssigned from form:', unitAssigned);

    // Find the unit by _id (expects a valid ObjectId)
    const unit = await Unit.findById(unitAssigned);
    if (!unit) {
      return res.status(400).send(`No unit found with ID: ${unitAssigned}`);
    }

    const tenant = new Tenant({
      name,
      phoneNumber: user.phoneNumber,
      userId: user._id,
      propertyName,
      unitAssigned: unit._id, // Use the Unit's _id (ObjectId) for the reference
      lease_start: new Date(lease_start),
      deposit,
      rent_amount,
      tenant_id: tenant_id || await generateTenantId(), // Use provided ID or generate one
    });

    if (req.files.photo) {
      const key = 'images/' + Date.now() + '-' + req.files.photo[0].originalname;
      const uploadParams = {
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.files.photo[0].buffer,
        ContentType: req.files.photo[0].mimetype,
      };
      await s3.upload(uploadParams).promise();
      tenant.photo = process.env.R2_PUBLIC_URL + '/' + key;
    }

    if (req.files.idProof) {
      const key = 'images/' + Date.now() + '-' + req.files.idProof[0].originalname;
      const uploadParams = {
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.files.idProof[0].buffer,
        ContentType: req.files.idProof[0].mimetype,
      };
      await s3.upload(uploadParams).promise();
      tenant.idProof = process.env.R2_PUBLIC_URL + '/' + key;
    }

    await tenant.save();

    // Send WhatsApp confirmation
    await sendMessage(
      phoneNumber,
      `Tenant "${name}" has been added to unit "${unit.unitNumber}" (ID: ${unit.unit_id}) at property "${propertyName}".`
    );

    // Mark authorization as used and delete it
    await Authorize.findByIdAndDelete(id);

    res.send('Tenant added successfully!');
  } catch (error) {
    console.error('Error adding tenant:', error);
    res.status(500).send('An error occurred while adding the tenant.');
  }
});
// GET route to render the edit property form with current data
// POST route to update the property
// POST route to update the property
app.post('/editproperty/:id', upload.single('image'), async (req, res) => {
    const { propertyId, property_name, units, address, totalAmount } = req.body;
    const id = req.params.id;

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            console.error('Authorization record not found for ID:', id);
            return res.status(404).send('Authorization record not found.');
        }

        if (authorizeRecord.used) {
            console.error('Authorization already used for ID:', id);
            return res.status(403).send('This link has already been used.');
        }

        const phoneNumber = authorizeRecord.phoneNumber;
        const user = await User.findOne({ phoneNumber });
        if (!user) {
            console.error('User not found for phoneNumber:', phoneNumber);
            return res.status(404).send('User not found.');
        }

        // Update the property
        const property = await Property.findOne({ _id: propertyId, userId: user._id });
        if (!property) {
            return res.status(404).send('Property not found or you do not have permission to edit it.');
        }

        property.name = property_name;
        property.units = units;
        property.address = address;
        property.totalAmount = totalAmount;

        // Handle image upload if provided
        if (req.file) {
            const key = 'images/' + Date.now() + '-' + req.file.originalname;
            const uploadParams = {
                Bucket: process.env.R2_BUCKET,
                Key: key,
                Body: req.file.buffer,
                ContentType: req.file.mimetype,
            };

            await s3.upload(uploadParams).promise();
            const imageUrl = process.env.R2_PUBLIC_URL + '/' + key;

            // If property already has an image, update it; otherwise, create a new one
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

        // Send WhatsApp confirmation message
        await sendMessage(phoneNumber, `Property "${property_name}" has been successfully updated.`);

        // Mark authorization as used and delete it
        authorizeRecord.used = true;
        await authorizeRecord.save();
        await Authorize.findByIdAndDelete(id);

        res.send('Property updated successfully!');
    } catch (error) {
        console.error('Error updating property:', error);
        res.status(500).send('Error updating property.');
    }
});
// GET route to render the edit property form with current data
app.get('/editproperty/:id', checkOTPValidation, async (req, res) => {
    const id = req.params.id;

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        // Check if the authorization has already been used
        if (authorizeRecord.used) {
            return res.status(403).send('This link has already been used.');
        }

        // Fetch all properties for the user
        const phoneNumber = authorizeRecord.phoneNumber;
        const user = await User.findOne({ phoneNumber });
        if (!user) {
            return res.status(404).send('User not found.');
        }

        const properties = await Property.find({ userId: user._id });
        if (!properties.length) {
            return res.status(404).send('No properties found to edit.');
        }

        // Render the edit property form with properties list
        res.render('editProperty', { id, properties });
    } catch (error) {
        console.error('Error rendering edit property form:', error);
        res.status(500).send('An error occurred while rendering the form.');
    }
});


app.post('/deleteproperty/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;
  const { propertyId } = req.body; // Expect propertyId from the form

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    // Find and delete the property
    const property = await Property.findOneAndDelete({
      _id: propertyId,
      userId: user._id,
    });

    if (!property) {
      return res.status(404).send('Property not found or you do not have permission to delete it.');
    }

    // Send WhatsApp confirmation message
    await sendMessage(
      phoneNumber,
      `Property "${property.name}" has been successfully deleted.`
    );

    // Mark authorization as used and delete it
    authorizeRecord.used = true;
    await authorizeRecord.save();
    await Authorize.findByIdAndDelete(id);

    res.send('Property deleted successfully!');
  } catch (error) {
    console.error('Error deleting property:', error);
    res.status(500).send('Error deleting property.');
  }
});
// GET route to render the edit unit form (with list of properties if needed)
// POST route to update the unit
app.post('/editunit/:id', upload.single('image'), async (req, res) => {
  const { unitId, property, unit_number, rent_amount, floor, size } = req.body;
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const unit = await Unit.findOne({ _id: unitId, userId: user._id });
    if (!unit) {
      return res.status(404).send('Unit not found or you do not have permission to edit it.');
    }

    unit.property = property;
    unit.unitNumber = unit_number;
    unit.rentAmount = rent_amount;
    unit.floor = floor;
    unit.size = size;

    if (req.file) {
      const key = 'images/' + Date.now() + '-' + req.file.originalname;
      const uploadParams = {
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      };

      await s3.upload(uploadParams).promise();
      const imageUrl = process.env.R2_PUBLIC_URL + '/' + key;

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

    // Send WhatsApp confirmation
    const propertyDoc = await Property.findById(property);
    await sendMessage(
      phoneNumber,
      `Unit "${unit_number}" in property "${propertyDoc ? propertyDoc.name : 'Unknown'}" has been updated.`
    );

    // Mark authorization as used and delete it
    authorizeRecord.used = true;
    await authorizeRecord.save();
    await Authorize.findByIdAndDelete(id);

    res.send('Unit updated successfully!');
  } catch (error) {
    console.error('Error updating unit:', error);
    res.status(500).send('Error updating unit.');
  }
});

app.post('/deleteunit/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;
  const { unitId } = req.body; // Expect unitId from the form

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const unit = await Unit.findOneAndDelete({ _id: unitId, userId: user._id });
    if (!unit) {
      return res.status(404).send('Unit not found or you do not have permission to delete it.');
    }

    // Send WhatsApp confirmation message
    await sendMessage(
      phoneNumber,
      `Unit "${unit.unitNumber}" has been successfully deleted.`
    );

    // Mark authorization as used and delete it
    authorizeRecord.used = true;
    await authorizeRecord.save();
    await Authorize.findByIdAndDelete(id);

    res.send('Unit deleted successfully!');
  } catch (error) {
    console.error('Error deleting unit:', error);
    res.status(500).send('Error deleting unit.');
  }
});
// GET route to render the edit tenant form with current data
// POST route to update the tenant
app.post('/edittenant/:id', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'idProof', maxCount: 1 }]), async (req, res) => {
  const { tenantId, name, propertyName, unitAssigned, lease_start, deposit, rent_amount } = req.body;
  const id = req.params.id;

  console.log(`POST /edittenant/:id called with id: ${id}, tenantId: ${tenantId}`);

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      console.log(`Authorize record not found for id: ${id}`);
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      console.log(`Authorize record already used for id: ${id}`);
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      console.log(`User not found for phoneNumber: ${phoneNumber}`);
      return res.status(404).send('User not found.');
    }

    const tenant = await Tenant.findOne({ _id: tenantId, userId: user._id });
    if (!tenant) {
      console.log(`Tenant not found for tenantId: ${tenantId}, userId: ${user._id}`);
      return res.status(404).send('Tenant not found or you do not have permission to edit it.');
    }

    // Validate unitAssigned
    const unit = await Unit.findById(unitAssigned);
    if (!unit) {
      console.log(`Unit not found for unitAssigned: ${unitAssigned}`);
      return res.status(400).send(`No unit found with ID: ${unitAssigned}`);
    }

    // Update tenant fields
    tenant.name = name;
    tenant.propertyName = propertyName;
    tenant.unitAssigned = unit._id;
    tenant.lease_start = new Date(lease_start);
    tenant.deposit = deposit;
    tenant.rent_amount = rent_amount;

    // Handle file uploads (if present)
    if (req.files['photo']) {
      tenant.photo = {
        data: req.files['photo'][0].buffer,
        contentType: req.files['photo'][0].mimetype
      };
    }
    if (req.files['idProof']) {
      tenant.idProof = {
        data: req.files['idProof'][0].buffer,
        contentType: req.files['idProof'][0].mimetype
      };
    }

    await tenant.save();
    console.log(`Tenant ${tenantId} updated successfully`);

    // Send WhatsApp message
    const whatsappMessage = `Tenant "${name}" edited successfully!`;
    await sendMessage(phoneNumber, whatsappMessage);
    console.log(`WhatsApp message sent to ${phoneNumber}: ${whatsappMessage}`);

    // Mark authorization as used and delete it
    await Authorize.findByIdAndDelete(id);

    res.send('Tenant updated successfully! Check WhatsApp for confirmation.');
  } catch (error) {
    console.error('Error updating tenant:', error);
    res.status(500).send('Error updating tenant.');
  }
});
/////////////////////////////////////////////////////////////////////////////////////////////

// Helper function to generate a 6-digit OTP
// Helper function to generate a 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Function to send OTP via WhatsApp
async function sendOTP(phoneNumber, otp) {
  console.log(`sendOTP function called for phone number: ${phoneNumber}`); // Debug log

  try {
    const response = await axios.post(process.env.WHATSAPP_API_URL, {
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

    console.log(`OTP sent to ${phoneNumber}: ${otp}`); // Debug log
    console.log('WhatsApp API response:', response.data); // Debug log
  } catch (error) {
    console.error('Error sending OTP:', error.response ? {
      status: error.response.status,
      data: error.response.data,
      headers: error.response.headers,
    } : error.message); // Debug log
  }
}
// In-memory store for OTPs and attempts
const otpStore = new Map(); // { phoneNumber: { otp: '123456', attempts: 0, lastAttempt: Date } }

// Route to request OTP
app.get('/request-otp/:id', async (req, res) => {
  const id = req.params.id;
  console.log(`/request-otp/:id route called with ID: ${id}`);

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      console.error('Authorization record not found for ID:', id);
      return res.status(404).send('Authorization record not found.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    console.log(`Phone number extracted from authorizeRecord: ${phoneNumber}`);

    const otp = generateOTP();
    console.log(`Generated OTP: ${otp}`);

    otpStore.set(phoneNumber, { otp, attempts: 0, lastAttempt: null, validated: false });
    console.log(`OTP stored for phone number: ${phoneNumber}`);

    // Store phoneNumber in session and verify
    req.session.phoneNumber = phoneNumber;
    console.log(`Session phoneNumber set to: ${req.session.phoneNumber}`);
    console.log(`Full session object: ${JSON.stringify(req.session)}`);

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
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const storedOTPData = otpStore.get(phoneNumber);

    if (!storedOTPData) {
      return res.status(400).json({ error: 'OTP expired or not requested.' });
    }

    const { otp: storedOTP, attempts, lastAttempt } = storedOTPData;

    if (attempts >= 3 && Date.now() - lastAttempt < 180000) {
      return res.status(429).json({ error: 'Too many attempts. Try again after 3 minutes.' });
    }

    if (otp === storedOTP) {
      otpStore.set(phoneNumber, { ...storedOTPData, validated: true });
      console.log(`OTP validated for ${phoneNumber}. Determining redirect...`);

      const tenantId = req.query.tenantId;
      console.log(`tenantId from query: ${tenantId}`);

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
        case 'addunit':
          redirectUrl = `/addunit/${id}`;
          break;
        case 'editunit':
          redirectUrl = `/editunit/${id}`;
          break;
        case 'addtenant':
          redirectUrl = `/addtenant/${id}`;
          break;
        default:
          redirectUrl = `/editproperty/${id}`; // Default case
      }

      console.log(`Redirecting to: ${redirectUrl}`);
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




// Route to render the OTP input page
app.get('/authorize/:id', async (req, res) => {
  const id = req.params.id;
  console.log(`/authorize/:id route called with ID: ${id}`); // Debug log

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      console.error('Authorization record not found for ID:', id); // Debug log
      return res.status(404).send('Authorization record not found.');
    }

    // Render the OTP input page
    console.log(`Rendering OTP input page for phone number: ${authorizeRecord.phoneNumber}`); // Debug log
    res.sendFile(path.join(__dirname, 'public', 'otp.html'));
  } catch (error) {
    console.error('Error in /authorize/:id route:', error); // Debug log
    res.status(500).send('An error occurred while rendering the OTP page.');
  }
});

// Middleware to check if OTP is validated
function checkOTPValidation(req, res, next) {
  const id = req.params.id;
  const phoneNumber = req.session.phoneNumber;

  console.log(`checkOTPValidation: ID = ${id}, Session phoneNumber = ${phoneNumber}`); // Debug log
  console.log(`Full session object: ${JSON.stringify(req.session)}`); // Debug log

  if (!phoneNumber) {
    console.error('No phoneNumber in session. OTP not requested.');
    return res.status(401).send('OTP not requested. Please request an OTP first.');
  }

  const storedOTPData = otpStore.get(phoneNumber);
  console.log(`otpStore data for ${phoneNumber}: ${JSON.stringify(storedOTPData)}`); // Debug log

  if (!storedOTPData || !storedOTPData.validated) {
    console.error('OTP not validated or not found in otpStore.');
    return res.status(401).send('OTP not validated. Please validate the OTP first.');
  }

  console.log(`OTP validated successfully for ${phoneNumber}. Proceeding...`);
  next();
}



app.get('/addproperty/:id', checkOTPValidation, async (req, res) => {
    const id = req.params.id;

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        // Check if the authorization has already been used
        if (authorizeRecord.used) {
            return res.status(403).send('This link has already been used.');
        }

        // Render the add property form
        res.render('addProperty', { id });
    } catch (error) {
        console.error('Error rendering add property form:', error);
        res.status(500).send('An error occurred while rendering the form.');
    }
});

app.get('/removeproperty/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const properties = await Property.find({ userId: user._id });
    if (!properties.length) {
      return res.status(404).send('No properties found to remove.');
    }

    // Render the remove property form with properties list
    res.render('removeProperty', { id, properties });
  } catch (error) {
    console.error('Error rendering remove property form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.get('/removeunit/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const units = await Unit.find({ userId: user._id });
    if (!units.length) {
      return res.status(404).send('No units found to remove.');
    }

    const properties = await Property.find({ userId: user._id }); // For property names
    res.render('removeUnit', { id, units, properties });
  } catch (error) {
    console.error('Error rendering remove unit form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.get('/removetenant/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const tenants = await Tenant.find({ userId: user._id });
    if (!tenants.length) {
      return res.status(404).send('No tenants found to remove.');
    }

    res.render('removeTenant', { id, tenants });
  } catch (error) {
    console.error('Error rendering remove tenant form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.get('/addunit/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const properties = await Property.find({ userId: user._id });
    if (!properties.length) {
      return res.status(404).send('No properties found. Please add a property first.');
    }

    res.render('addUnit', { id, properties });
  } catch (error) {
    console.error('Error rendering add unit form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.get('/editunit/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const units = await Unit.find({ userId: user._id });
    if (!units.length) {
      return res.status(404).send('No units found to edit.');
    }

    const properties = await Property.find({ userId: user._id });
    res.render('editUnit', { id, units, properties });
  } catch (error) {
    console.error('Error rendering edit unit form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.get('/addtenant/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    if (authorizeRecord.used) {
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).send('User not found.');
    }

    const properties = await Property.find({ userId: user._id });
    const units = await Unit.find({ userId: user._id });
    if (!properties.length || !units.length) {
      return res.status(404).send('No properties or units found. Please add them first.');
    }

    res.render('addTenant', { id, properties, units });
  } catch (error) {
    console.error('Error rendering add tenant form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

app.get('/edittenant/:id', checkOTPValidation, async (req, res) => {
  const id = req.params.id;
  const tenantId = req.query.tenantId;

  console.log(`GET /edittenant/:id called with id: ${id}, tenantId: ${tenantId}`);

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      console.log(`Authorize record not found for id: ${id}`);
      return res.status(404).send('Authorization record not found.');
    }
    if (authorizeRecord.used) {
      console.log(`Authorize record already used for id: ${id}`);
      return res.status(403).send('This link has already been used.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      console.log(`User not found for phoneNumber: ${phoneNumber}`);
      return res.status(404).send('User not found.');
    }

    if (!tenantId || !mongoose.Types.ObjectId.isValid(tenantId)) {
      console.log(`Invalid or missing tenantId: ${tenantId}`);
      return res.status(400).send('Invalid or missing tenantId.');
    }

    const tenant = await Tenant.findOne({ _id: tenantId, userId: user._id });
    if (!tenant) {
      console.log(`Tenant not found for tenantId: ${tenantId}, userId: ${user._id}`);
      return res.status(404).send('Tenant not found or invalid tenantId.');
    }

    const properties = await Property.find({ userId: user._id });
    const units = await Unit.find({ userId: user._id });

    res.render('editTenant', { id, tenant, properties, units });
  } catch (error) {
    console.error('Error rendering edit tenant form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});
// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});