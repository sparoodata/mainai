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
const fs = require('fs');
const Tenant = require('./models/Tenant');
const Image = require('./models/Image');
const Property = require('./models/Property');
const Authorize = require('./models/Authorize');
const Unit = require('./models/Unit');
const BoxSDK = require('box-node-sdk'); // Box SDK

const app = express();
const port = process.env.PORT || 3000; // Glitch uses dynamic port

// Configure Box SDK
const sdk = BoxSDK.getPreconfiguredInstance({
    boxAppSettings: {
        clientID: process.env.BOX_CLIENT_ID,
        clientSecret: process.env.BOX_CLIENT_SECRET,
        appAuth: {
            publicKeyID: process.env.BOX_PUBLIC_KEY_ID,
            privateKey: process.env.BOX_PRIVATE_KEY.replace(/\\n/g, '\n'), // Properly format private key
            passphrase: process.env.BOX_PASSPHRASE
        }
    },
    enterpriseID: process.env.BOX_ENTERPRISE_ID
});

// Authenticate as App User (replace APP_USER_ID with the actual Box App User ID)
const client = sdk.getAppAuthClient('user', process.env.BOX_APP_USER_ID);

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

// Configure multer for image uploads
const upload = multer({ 
    storage: multer.memoryStorage(), // Use memory storage since we'll upload directly to Box
    limits: { fileSize: 5 * 1024 * 1024 }, // Limit file size to 5 MB
});

// Function to upload file to Box
async function uploadFileToBox(fileBuffer, fileName) {
    try {
        const folderId = '0'; // Root folder, or specify another folder ID if needed
        const uploadedFile = await client.files.uploadFile(folderId, fileName, fileBuffer);
        console.log(`File uploaded to Box: ${uploadedFile.entries[0].id}`);
        return uploadedFile.entries[0].id;
    } catch (error) {
        console.error('Error uploading to Box:', error);
        throw error;
    }
}

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
        const messageSent = await sendWhatsAppAuthMessage(phoneNumber, 'adding a property'); // Pass action type

        if (!messageSent) {
            return res.status(500).send('Failed to send WhatsApp authorization message.');
        }

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
    const action = req.query.action;

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = authorizeRecord.phoneNumber;
        const userResponse = await waitForUserResponse(phoneNumber);

        if (userResponse && userResponse.toLowerCase() === 'yes_authorize') {
            delete userResponses[phoneNumber];

            if (action === 'addproperty') {
                res.render('addProperty', { id });
            } else if (action === 'addunit') {
                const properties = await Property.find().select('name _id');
                res.render('addUnit', { id, properties });
            } else if (action === 'addtenant') {
                const properties = await Property.find().select('name _id');
                const units = await Unit.find().select('unitNumber _id property');
                res.render('addTenant', { id, properties, units });
            }
        } else {
            return res.json({ status: 'waiting' });
        }
    } catch (error) {
        console.error('Error checking authorization status:', error);
        res.status(500).send('An error occurred while checking authorization.');
    }
});

// Function to send WhatsApp message for authorization with dynamic action text
async function sendWhatsAppAuthMessage(phoneNumber, actionType) {
    const messageText = `Do you authorize this action for ${actionType}?`;

    try {
        const response = await axios.post(process.env.WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: messageText },
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

        if (response.status === 200) {
            console.log('WhatsApp message sent successfully');
            return true;
        } else {
            console.error('Failed to send WhatsApp message:', response.statusText);
            return false;
        }
    } catch (error) {
        console.error('Error sending WhatsApp message:', error.message || error);
        return false;
    }
}

// Handle form submission and image upload (add property)
app.post('/addproperty/:id', upload.single('image'), async (req, res) => {
    const { property_name, units, address, totalAmount } = req.body;

    try {
        const property = new Property({ name: property_name, units, address, totalAmount });
        await property.save();

        if (req.file) {
            const fileName = `${Date.now()}-${req.file.originalname}`;
            const fileId = await uploadFileToBox(req.file.buffer, fileName);

            const image = new Image({ propertyId: property._id, imageUrl: `https://app.box.com/file/${fileId}` });
            await image.save();
            property.images.push(image._id);
            await property.save();
        }

        res.send('Property and image added successfully to Box!');
    } catch (error) {
        console.error('Error adding property and image:', error);
        res.status(500).send('An error occurred while adding the property and image.');
    }
});

// Handle form submission and image upload (add unit)
app.post('/addunit/:id', upload.single('image'), async (req, res) => {
    const { property, unit_number, rent_amount, floor, size } = req.body;

    try {
        const unit = new Unit({ property, unitNumber: unit_number, rentAmount: rent_amount, floor, size });
        await unit.save();

        if (req.file) {
            const fileName = `${Date.now()}-${req.file.originalname}`;
            const fileId = await uploadFileToBox(req.file.buffer, fileName);

            const image = new Image({ unitId: unit._id, imageUrl: `https://app.box.com/file/${fileId}` });
            await image.save();
            unit.images.push(image._id);
            await unit.save();
        }

        res.send('Unit and image added successfully to Box!');
    } catch (error) {
        console.error('Error adding unit and image:', error);
        res.status(500).send('An error occurred while adding the unit and image.');
    }
});

// Handle form submission and image upload (add tenant)
app.post('/addtenant/:id', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'idProof', maxCount: 1 }]), async (req, res) => {
    const { name, phoneNumber, propertyName, unitAssigned, lease_start, deposit, rent_amount, tenant_id } = req.body;

    try {
        const tenant = new Tenant({
            name,
            phoneNumber,
            propertyName,
            unitAssigned,
            lease_start: new Date(lease_start),
            deposit,
            rent_amount,
            tenant_id,
        });

        if (req.files.photo) {
            const photoFile = req.files.photo[0];
            const fileName = `${Date.now()}-${photoFile.originalname}`;
            const fileId = await uploadFileToBox(photoFile.buffer, fileName);
            tenant.photo = `https://app.box.com/file/${fileId}`;
        }

        if (req.files.idProof) {
            const idProofFile = req.files.idProof[0];
            const fileName = `${Date.now()}-${idProofFile.originalname}`;
            const fileId = await uploadFileToBox(idProofFile.buffer, fileName);
            tenant.idProof = `https://app.box.com/file/${fileId}`;
        }

        await tenant.save();
        res.send('Tenant added successfully with images uploaded to Box!');
    } catch (error) {
        console.error('Error adding tenant:', error);
        res.status(500).send('An error occurred while adding the tenant.');
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
