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
const Dropbox = require('dropbox').Dropbox;
const fetch = require('isomorphic-fetch');

const app = express();
const port = process.env.PORT || 3000; // Glitch uses dynamic port
const AWS = require('aws-sdk');

// Configure the S3 client to use Cloudflare R2 settings
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT, // e.g., https://<account-id>.r2.cloudflarestorage.com
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  Bucket: process.env.R2_BUCKET,
  region: 'auto', // R2 doesn’t require a region but "auto" works for S3 compatibility
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

// Session setup
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
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

// Handle form submission and image upload to Dropbox (add property)
app.post('/addproperty/:id', upload.single('image'), async (req, res) => {
    const { property_name, units, address, totalAmount } = req.body;
    const id = req.params.id;

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = '+' + authorizeRecord.phoneNumber;
        const user = await User.findOne({ phoneNumber });
        if (!user) {
            return res.status(404).send('User not found.');
        }

        const property = new Property({ 
            name: property_name, 
            units, 
            address, 
            totalAmount, 
            userId: user._id 
        });
        await property.save();

        // Upload image to Cloudflare R2 if provided
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

            const image = new Image({ propertyId: property._id, imageUrl: imageUrl });
            await image.save();
            property.images.push(image._id);
            await property.save();
        }

        // Send WhatsApp confirmation message
        await sendMessage(authorizeRecord.phoneNumber, `Property *${property_name}* has been successfully added.`);

        res.send('Property and image added successfully!');
    } catch (error) {
        console.error('Error adding property and image:', error);
        res.status(500).send('An error occurred while adding the property and image.');
    }
});




// Handle form submission and image upload to Dropbox (add unit)
app.post('/addunit/:id', upload.single('image'), async (req, res) => {
    const { property, unit_number, rent_amount, floor, size } = req.body;
    const id = req.params.id;

    try {
        // Retrieve the authorization record
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = '+' + authorizeRecord.phoneNumber;

        // Retrieve the user
        const user = await User.findOne({ phoneNumber });
        if (!user) {
            return res.status(404).send('User not found.');
        }

        // Create new unit and reference the user by their ID
        const unit = new Unit({
            property, 
            unitNumber: unit_number, 
            rentAmount: rent_amount, 
            floor, 
            size, 
            userId: user._id
        });
        await unit.save();

        // Upload image to Cloudflare R2 if provided
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

        const phoneNumber = '+' + authorizeRecord.phoneNumber;
        const user = await User.findOne({ phoneNumber });
        if (!user) {
            return res.status(404).send('User not found.');
        }

        const tenant = new Tenant({
            name,
            phoneNumber: user.phoneNumber,
            userId: user._id,
            propertyName,
            unitAssigned,
            lease_start: new Date(lease_start),
            deposit,
            rent_amount,
            tenant_id,
        });

        // Upload tenant photo if provided
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

        // Upload tenant ID proof if provided
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

        // Send WhatsApp confirmation message with property name
await sendMessage(
    authorizeRecord.phoneNumber,
    `Tenant *${name}* has been successfully added to property *${propertyName}* (Unit: *${unitAssigned})*. Lease starts on ${new Date(lease_start).toLocaleDateString()}.`
);

        res.send('Tenant added successfully!');
    } catch (error) {
        console.error('Error adding tenant:', error);
        res.status(500).send('An error occurred while adding the tenant.');
    }
});

// GET route to render the edit property form with current data
// POST route to update the property
app.post('/editproperty/:id', async (req, res) => {
    try {
        const { property_name, units, address, totalAmount } = req.body;
        const property = await Property.findByIdAndUpdate(
            req.params.id,
            {
                name: property_name,
                units,
                address,
                totalAmount
            },
            { new: true }
        );

        // Send WhatsApp confirmation message
        const authorizeRecord = await Authorize.findOne({ _id: req.params.id });
        if (authorizeRecord) {
            await sendMessage(authorizeRecord.phoneNumber, `Property "${property_name}" has been successfully updated.`);
        }

        res.send('Property updated successfully!');
    } catch (error) {
        console.error('Error updating property:', error);
        res.status(500).send('Error updating property.');
    }
});

app.post('/deleteproperty/:id', async (req, res) => {
    try {
        const property = await Property.findByIdAndDelete(req.params.id);

        // Send WhatsApp confirmation message
        const authorizeRecord = await Authorize.findOne({ _id: req.params.id });
        if (authorizeRecord && property) {
            await sendMessage(authorizeRecord.phoneNumber, `Property "${property.name}" has been successfully deleted.`);
        }

        res.send('Property deleted successfully!');
    } catch (error) {
        console.error('Error deleting property:', error);
        res.status(500).send('Error deleting property.');
    }
});
// GET route to render the edit unit form (with list of properties if needed)
// POST route to update the unit
app.post('/editunit/:id', async (req, res) => {
  try {
    const { property, unit_number, rent_amount, floor, size } = req.body;
    const unit = await Unit.findByIdAndUpdate(
      req.params.id,
      {
        property,
        unitNumber: unit_number,
        rentAmount: rent_amount,
        floor,
        size
      },
      { new: true }
    );
    res.send('Unit updated successfully!');
  } catch (error) {
    console.error('Error updating unit:', error);
    res.status(500).send('Error updating unit.');
  }
});

app.post('/deleteunit/:id', async (req, res) => {
  try {
    await Unit.findByIdAndDelete(req.params.id);
    res.send('Unit deleted successfully!');
  } catch (error) {
    console.error('Error deleting unit:', error);
    res.status(500).send('Error deleting unit.');
  }
});
// GET route to render the edit tenant form with current data
// POST route to update the tenant
app.post('/edittenant/:id', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'idProof', maxCount: 1 }]), async (req, res) => {
  try {
    const { name, propertyName, unitAssigned, lease_start, deposit, rent_amount } = req.body;
    const updateData = {
      name,
      propertyName,
      unitAssigned,  // Make sure this is the ObjectId coming from the dropdown
      lease_start: new Date(lease_start),
      deposit,
      rent_amount,
    };

    // Optionally update photo if provided
    if (req.files.photo) {
      const key = 'images/' + Date.now() + '-' + req.files.photo[0].originalname;
      const uploadParams = {
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.files.photo[0].buffer,
        ContentType: req.files.photo[0].mimetype,
      };
      await s3.upload(uploadParams).promise();
      updateData.photo = process.env.R2_PUBLIC_URL + '/' + key;
    }
    // Optionally update ID proof if provided
    if (req.files.idProof) {
      const key = 'images/' + Date.now() + '-' + req.files.idProof[0].originalname;
      const uploadParams = {
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.files.idProof[0].buffer,
        ContentType: req.files.idProof[0].mimetype,
      };
      await s3.upload(uploadParams).promise();
      updateData.idProof = process.env.R2_PUBLIC_URL + '/' + key;
    }

    await Tenant.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.send('Tenant updated successfully!');
  } catch (error) {
    console.error('Error updating tenant:', error);
    res.status(500).send('Error updating tenant.');
  }
});

app.post('/deletetenant/:id', async (req, res) => {
  try {
    await Tenant.findByIdAndDelete(req.params.id);
    res.send('Tenant deleted successfully!');
  } catch (error) {
    console.error('Error deleting tenant:', error);
    res.status(500).send('Error deleting tenant.');
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
app.get('/request-otp/:phoneNumber', async (req, res) => {
  const phoneNumber = req.params.phoneNumber;

  try {
    // Check if an Authorize record already exists for this phone number
    let authorizeRecord = await Authorize.findOne({ phoneNumber });

    if (!authorizeRecord) {
      // Create a new Authorize record
      authorizeRecord = new Authorize({ phoneNumber });
      await authorizeRecord.save();
    }

    // Generate and send OTP
    const otp = generateOTP();
    await sendOTP(phoneNumber, otp);

    res.json({ status: 'OTP sent', id: authorizeRecord._id });
  } catch (error) {
    console.error('Error generating or sending OTP:', error);
    res.status(500).send('An error occurred while generating OTP.');
  }
});

// Route to request OTP
app.get('/request-otp/:id', async (req, res) => {
  const id = req.params.id;
  console.log(`/request-otp/:id route called with ID: ${id}`); // Debug log

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      console.error('Authorization record not found for ID:', id); // Debug log
      return res.status(404).send('Authorization record not found.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    console.log(`Phone number extracted from authorizeRecord: ${phoneNumber}`); // Debug log

    const otp = generateOTP();
    console.log(`Generated OTP: ${otp}`); // Debug log

    // Store OTP and reset attempts
    otpStore.set(phoneNumber, { otp, attempts: 0, lastAttempt: null, validated: false });
    console.log(`OTP stored for phone number: ${phoneNumber}`); // Debug log

    // Store phoneNumber in session
    req.session.phoneNumber = phoneNumber;
    console.log(`Phone number stored in session: ${phoneNumber}`); // Debug log

    // Send OTP via WhatsApp
    console.log(`Attempting to send OTP to ${phoneNumber}`); // Debug log
    await sendOTP(phoneNumber, otp);

    res.json({ status: 'OTP sent', phoneNumber });
  } catch (error) {
    console.error('Error in /request-otp/:id route:', error); // Debug log
    res.status(500).send('An error occurred while generating OTP.');
  }
});
// Route to validate OTP
// Route to validate OTP
app.post('/validate-otp/:id', async (req, res) => {
  const id = req.params.id;
  const { otp } = req.body;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).json({ error: 'Authorization record not found.' });
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const storedOTPData = otpStore.get(phoneNumber);

    if (!storedOTPData) {
      return res.status(400).json({ error: 'OTP expired or not requested.' });
    }

    const { otp: storedOTP, attempts, lastAttempt } = storedOTPData;

    // Check if the user is blocked due to too many attempts
    if (attempts >= 3 && Date.now() - lastAttempt < 180000) { // 3 minutes
      return res.status(429).json({ error: 'Too many attempts. Try again after 3 minutes.' });
    }

    // Validate OTP
    if (otp === storedOTP) {
      // Invalidate the link by deleting the Authorize record
      await Authorize.findByIdAndDelete(id);

      // Clear OTP from the store
      otpStore.delete(phoneNumber);

      res.json({ status: 'OTP validated', phoneNumber });
    } else {
      // Increment failed attempts
      otpStore.set(phoneNumber, { ...storedOTPData, attempts: attempts + 1, lastAttempt: Date.now() });
      res.status(400).json({ error: 'Invalid OTP.' });
    }
  } catch (error) {
    console.error('Error validating OTP:', error);
    res.status(500).json({ error: 'An error occurred while validating OTP.' });
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
  const phoneNumber = req.session.phoneNumber; // Store phoneNumber in session during OTP request

  if (!phoneNumber) {
    return res.status(401).send('OTP not requested. Please request an OTP first.');
  }

  const storedOTPData = otpStore.get(phoneNumber);
  if (!storedOTPData || !storedOTPData.validated) {
    return res.status(401).send('OTP not validated. Please validate the OTP first.');
  }

  next();
}

// Route to render the add property form (with ID)
app.get('/addproperty/:id', async (req, res) => {
  const id = req.params.id;

  try {
    // Check if the Authorize record exists
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('This link has expired or is invalid.');
    }

    // Render the add property form
    res.render('addProperty', { id });
  } catch (error) {
    console.error('Error rendering add property form:', error);
    res.status(500).send('An error occurred while rendering the form.');
  }
});

// Route to render the add property form (without ID)
app.get('/addproperty', (req, res) => {
  // Render a success page or the add property form without the ID
  res.render('addPropertySuccess'); // Replace with your desired view
});
// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
