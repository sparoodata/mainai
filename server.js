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
const { router, waitForUserResponse, userResponses } = require('./routes/webhook');
app.use('/webhook', router);

// Add property route that waits for WhatsApp authorization
app.get('/addproperty/:id', async (req, res) => {
    const id = req.params.id;

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = authorizeRecord.phoneNumber;
        await sendWhatsAppAuthMessage(phoneNumber); // Send WhatsApp authorization message

        // Render the waiting page for WhatsApp authorization
        res.render('waitingAuthorization', { id, action: 'addproperty' });
    } catch (error) {
        console.error('Error during authorization or fetching phone number:', error);
        res.status(500).send('An error occurred during authorization.');
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

    // Normalize phone number by removing any leading "+"
    const rawPhone = authorizeRecord.phoneNumber;
    const phoneNumber = rawPhone.startsWith('+') ? rawPhone.substring(1) : rawPhone;
    
    console.log("Waiting for response from phone:", phoneNumber);

    let userResponse;
    try {
      userResponse = await waitForUserResponse(phoneNumber);
    } catch (error) {
      return res.status(408).send('Authorization timed out. Please try again.');
    }

    if (userResponse && userResponse.toLowerCase() === 'yes_authorize') {
      delete userResponses[phoneNumber]; // Clean up after capture

      if (action === 'addproperty') {
        res.render('addProperty', { id });
      } else if (action === 'addunit') {
        const properties = await Property.find().select('name _id');
        res.render('addUnit', { id, properties });
      } else if (action === 'addtenant') {
        const properties = await Property.find().select('name _id');
        const units = await Unit.find().select('unitNumber _id property');
        const tenantId = generateTenantId();
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
        // Retrieve the authorization record using the provided id
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        // Build the phone number (ensure the format is correct)
        const phoneNumber = '+' + authorizeRecord.phoneNumber;

        // Retrieve the user based on the phone number
        const user = await User.findOne({ phoneNumber });
        if (!user) {
            return res.status(404).send('User not found.');
        }

        // Create new property and reference the user by their ID
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

        // Create new tenant and reference the user by their ID
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
        res.send('Tenant added successfully!');
    } catch (error) {
        console.error('Error adding tenant:', error);
        res.status(500).send('An error occurred while adding the tenant.');
    }
});

// Render the edit property form with pre-filled data
app.get('/editproperty/:id', async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).send('Property not found.');
    res.render('editProperty', { property });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error retrieving property.');
  }
});

// Update the property
app.post('/editproperty/:id', async (req, res) => {
  try {
    const { property_name, units, address, totalAmount } = req.body;
    const property = await Property.findByIdAndUpdate(
      req.params.id,
      { name: property_name, units, address, totalAmount },
      { new: true }
    );
    res.send('Property updated successfully!');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error updating property.');
  }
});
app.post('/deleteproperty/:id', async (req, res) => {
  try {
    await Property.findByIdAndDelete(req.params.id);
    res.send('Property deleted successfully!');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error deleting property.');
  }
});
app.get('/editunit/:id', async (req, res) => {
  try {
    const unit = await Unit.findById(req.params.id);
    if (!unit) return res.status(404).send('Unit not found.');
    const properties = await Property.find().select('name _id');
    res.render('editUnit', { unit, properties });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error retrieving unit.');
  }
});

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
    console.error(error);
    res.status(500).send('Error updating unit.');
  }
});
app.post('/deleteunit/:id', async (req, res) => {
  try {
    await Unit.findByIdAndDelete(req.params.id);
    res.send('Unit deleted successfully!');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error deleting unit.');
  }
});
app.get('/edittenant/:id', async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).send('Tenant not found.');
    const properties = await Property.find().select('name _id');
    const units = await Unit.find().select('unitNumber _id property');
    res.render('editTenant', { tenant, properties, units });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error retrieving tenant.');
  }
});

app.post('/edittenant/:id', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'idProof', maxCount: 1 }]), async (req, res) => {
  try {
    const { name, propertyName, unitAssigned, lease_start, deposit, rent_amount } = req.body;
    const updateData = {
      name,
      propertyName,
      unitAssigned, // Now this should be a valid ObjectId from the dropdown
      lease_start: new Date(lease_start),
      deposit,
      rent_amount,
    };

    // Optionally update photo and idProof if provided (using your R2 upload code)
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
app.post('/removetenant/:id', async (req, res) => {
  try {
    await Tenant.findByIdAndDelete(req.params.id);
    res.send('Tenant deleted successfully!');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error deleting tenant.');
  }
});



// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
