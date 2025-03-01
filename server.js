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


// Add property route that waits for WhatsApp authorization
app.get('/authorize/:id', async (req, res) => {
  const id = req.params.id;
  res.redirect(`/authorize/${id}?redirect=/addproperty/${id}`);

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    // Render the OTP input page
    res.sendFile(path.join(__dirname, 'public', 'otp.html'));
  } catch (error) {
    console.error('Error rendering OTP page:', error);
    res.status(500).send('An error occurred while rendering the OTP page.');
  }
});

// Check authorization and render the appropriate form (Add Property, Add Unit, or Add Tenant)
app.get('/checkAuthorization/:id', async (req, res) => {
  const id = req.params.id;
  const action = req.query.action; // addproperty, addunit, or addtenant

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    let userResponse;
    try {
      userResponse = await waitForUserResponse(phoneNumber);
    } catch (error) {
      return res.status(408).send('Authorization timed out. Please try again.');
    }

    if (userResponse && userResponse.toLowerCase() === 'yes_authorize') {
      // Clear stored response
      delete userResponses[phoneNumber];

      if (action === 'addproperty') {
        res.render('addProperty', { id });
      } else if (action === 'addunit') {
        const properties = await Property.find().select('name _id');
        res.render('addUnit', { id, properties });
      } else if (action === 'addtenant') {
        const properties = await Property.find().select('name _id');
        const units = await Unit.find().select('unitNumber _id property');
        const tenantId = generateTenantId(); // see next section
        res.render('addTenant', { id, properties, units, tenantId });
      }
    } else {
      res.json({ status: 'waiting' });
    }
  } catch (error) {
    console.error('Error checking authorization status:', error);
    res.status(500).send('An error occurred while checking authorization.');
  }
});



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

app.get('/addunit/:id', async (req, res) => {
    const id = req.params.id;

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = authorizeRecord.phoneNumber;
        // Send WhatsApp authorization message
        await sendWhatsAppAuthMessage(phoneNumber);

        // Render a waiting page until authorization is confirmed
        res.render('waitingAuthorization', { id, action: 'addunit' });
    } catch (error) {
        console.error('Error during authorization or fetching properties:', error);
        res.status(500).send('An error occurred while fetching data.');
    }
});


function generateTenantId() {
    // Generate a random 4-digit number (ensuring it is always 4 digits)
    const digits = Math.floor(1000 + Math.random() * 9000);
    // Generate a random uppercase letter (A-Z)
    const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    return 'T' + digits + letter;
}


// Route to get units for a selected property
app.get('/getUnits/:propertyId', async (req, res) => {
    const propertyId = req.params.propertyId;

    try {
        // Fetch units from the database based on the selected property
        const units = await Unit.find({ property: propertyId }).select('unitNumber _id');
        res.json(units); // Return the list of units in JSON format
    } catch (error) {
        console.error('Error fetching units:', error);
        res.status(500).send('An error occurred while fetching units.');
    }
});


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
app.get('/addtenant/:id', async (req, res) => {
    const id = req.params.id;

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = authorizeRecord.phoneNumber;
        await sendWhatsAppAuthMessage(phoneNumber); // Send WhatsApp authorization message

        // Render the waiting page for WhatsApp authorization
        res.render('waitingAuthorization', { id, action: 'addtenant' });
    } catch (error) {
        console.error('Error during authorization or fetching phone number:', error);
        res.status(500).send('An error occurred during authorization.');
    }
});

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
app.get('/editproperty/:id', async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).send('Property not found.');
    res.render('editProperty', { property });
  } catch (error) {
    console.error('Error retrieving property:', error);
    res.status(500).send('Error retrieving property.');
  }
});

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
app.get('/editunit/:id', async (req, res) => {
  try {
    const unit = await Unit.findById(req.params.id);
    if (!unit) return res.status(404).send('Unit not found.');
    // Fetch properties to allow re‑assigning the unit (if desired)
    const properties = await Property.find().select('name _id');
    res.render('editUnit', { unit, properties });
  } catch (error) {
    console.error('Error retrieving unit:', error);
    res.status(500).send('Error retrieving unit.');
  }
});

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
app.get('/edittenant/:id', async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).send('Tenant not found.');
    // Fetch properties and units for dropdowns
    const properties = await Property.find().select('name _id');
    const units = await Unit.find().select('unitNumber _id property');
    res.render('editTenant', { tenant, properties, units });
  } catch (error) {
    console.error('Error retrieving tenant:', error);
    res.status(500).send('Error retrieving tenant.');
  }
});

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
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Function to send OTP via WhatsApp
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
    console.log(`OTP sent to ${phoneNumber}: ${otp}`);
  } catch (error) {
    console.error('Error sending OTP:', error.response ? error.response.data : error);
  }
}

const otpStore = new Map(); // { phoneNumber: { otp: '123456', attempts: 0, lastAttempt: Date } }

// Middleware to generate and send OTP
app.get('/request-otp/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    const phoneNumber = authorizeRecord.phoneNumber;
    const otp = generateOTP();

    // Store OTP and reset attempts
    otpStore.set(phoneNumber, { otp, attempts: 0, lastAttempt: null });

    // Send OTP via WhatsApp
    await sendOTP(phoneNumber, otp);

    res.json({ status: 'OTP sent', phoneNumber });
  } catch (error) {
    console.error('Error generating or sending OTP:', error);
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

    // Check if the user is blocked due to too many attempts
    if (attempts >= 3 && Date.now() - lastAttempt < 180000) { // 3 minutes
      return res.status(429).json({ error: 'Too many attempts. Try again after 3 minutes.' });
    }

    // Validate OTP
    if (otp === storedOTP) {
      otpStore.delete(phoneNumber); // Clear OTP after successful validation
      res.json({ status: 'OTP validated', phoneNumber });
    } else {
      // Increment failed attempts
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
    if (!authorizeRecord) {
      return res.status(404).send('Authorization record not found.');
    }

    // Render the OTP input page
    res.sendFile(path.join(__dirname, 'public', 'otp.html'));
  } catch (error) {
    console.error('Error rendering OTP page:', error);
    res.status(500).send('An error occurred while rendering the OTP page.');
  }
});
app.get('/addproperty/:id', async (req, res) => {
  const id = req.params.id;
  res.redirect(`/authorize/${id}?redirect=/addproperty/${id}`);
});
// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
