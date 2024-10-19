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
const { authenticate, uploadFileToGoogleDrive } = require('./googleDrive'); // Import Google Drive functions

const app = express();
const port = process.env.PORT || 3000; // Glitch uses dynamic port

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
    storage: multer.memoryStorage(), // Use memory storage since we'll upload directly to Google Drive
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
    const action = req.query.action; // This action can now be addproperty, addunit, or addtenant

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = authorizeRecord.phoneNumber;
        const userResponse = await waitForUserResponse(phoneNumber);

        if (userResponse && userResponse.toLowerCase() === 'yes_authorize') {
            delete userResponses[phoneNumber]; // Clear the stored response

            if (action === 'addproperty') {
                res.render('addProperty', { id });
            } else if (action === 'addunit') {
                const properties = await Property.find().select('name _id'); // Fetch properties
                res.render('addUnit', { id, properties });
            } else if (action === 'addtenant') {
                const properties = await Property.find().select('name _id'); // Fetch properties for tenant assignment
                const units = await Unit.find().select('unitNumber _id property'); // Fetch units for tenant assignment
                res.render('addTenant', { id, properties, units }); // Render a form where users can add a tenant
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
    // Customize the authorization message based on the action type
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

        // Check response status
        if (response.status === 200) {
            console.log('WhatsApp message sent successfully');
            return true; // Indicates success
        } else {
            console.error('Failed to send WhatsApp message:', response.statusText);
            return false; // Indicates failure
        }
    } catch (error) {
        console.error('Error sending WhatsApp message:', error.message || error);
        return false; // Indicates failure
    }
}

// Route to get units for a selected property
app.get('/getUnits/:propertyId', async (req, res) => {
    const propertyId = req.params.propertyId;

    try {
        // Fetch units from the database based on the selected property
        const units = await Unit.find({ property: propertyId }).select('unitNumber _id');
        res.json(units);
    } catch (error) {
        console.error('Error fetching units:', error);
        res.status(500).send('An error occurred while fetching units.');
    }
});

// Handle form submission and image upload (add property)
app.post('/addproperty/:id', upload.single('image'), async (req, res) => {
    const { property_name, units, address, totalAmount } = req.body;

    try {
        const property = new Property({ name: property_name, units, address, totalAmount });
        await property.save();

        if (req.file) {
            // Authenticate with Google Drive and upload the file
            const auth = await authenticate();
            const fileName = `${Date.now()}-${req.file.originalname}`;
            // Write the file buffer to a temporary file
            const tempFilePath = path.join(__dirname, 'temp', fileName);
            fs.writeFileSync(tempFilePath, req.file.buffer);

            const fileId = await uploadFileToGoogleDrive(auth, tempFilePath, fileName);

            // Delete the temporary file
            fs.unlinkSync(tempFilePath);

            const image = new Image({ propertyId: property._id, imageUrl: `https://drive.google.com/uc?id=${fileId}` });
            await image.save();
            property.images.push(image._id);
            await property.save();
        }

        res.send('Property and image added successfully to Google Drive!');
    } catch (error) {
        console.error('Error adding property and image:', error);
        res.status(500).send('An error occurred while adding the property and image.');
    }
});

// Add unit route (rendering the form)
app.get('/addunit/:id', async (req, res) => {
    const id = req.params.id;

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = authorizeRecord.phoneNumber;
        const messageSent = await sendWhatsAppAuthMessage(phoneNumber, 'adding a unit'); // Pass action type

        if (!messageSent) {
            return res.status(500).send('Failed to send WhatsApp authorization message.');
        }

        const properties = await Property.find().select('name _id'); // Fetch properties for unit assignment
        res.render('addUnit', { id, properties });
    } catch (error) {
        console.error('Error fetching properties:', error);
        res.status(500).send('An error occurred while fetching properties.');
    }
});

// Handle form submission and image upload (add unit)
app.post('/addunit/:id', upload.single('image'), async (req, res) => {
    const { property, unit_number, rent_amount, floor, size } = req.body;

    try {
        const unit = new Unit({ property, unitNumber: unit_number, rentAmount: rent_amount, floor, size });
        await unit.save();

        if (req.file) {
            // Authenticate with Google Drive and upload the file
            const auth = await authenticate();
            const fileName = `${Date.now()}-${req.file.originalname}`;
            // Write the file buffer to a temporary file
            const tempFilePath = path.join(__dirname, 'temp', fileName);
            fs.writeFileSync(tempFilePath, req.file.buffer);

            const fileId = await uploadFileToGoogleDrive(auth, tempFilePath, fileName);

            // Delete the temporary file
            fs.unlinkSync(tempFilePath);

            const image = new Image({ unitId: unit._id, imageUrl: `https://drive.google.com/uc?id=${fileId}` });
            await image.save();
            unit.images.push(image._id);
            await unit.save();
        }

        res.send('Unit and image added successfully to Google Drive!');
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
        const messageSent = await sendWhatsAppAuthMessage(phoneNumber, 'adding a tenant'); // Pass action type

        if (!messageSent) {
            return res.status(500).send('Failed to send WhatsApp authorization message.');
        }

        const properties = await Property.find().select('name _id');
        const units = await Unit.find().select('unitNumber _id property');
        res.render('addTenant', { id, properties, units });
    } catch (error) {
        console.error('Error during authorization or fetching phone number:', error);
        res.status(500).send('An error occurred during authorization.');
    }
});

app.post('/addtenant/:id', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'idProof', maxCount: 1 }]), async (req, res) => {
    const { name, phoneNumber, propertyName, unitAssigned, lease_start, deposit, rent_amount, tenant_id } = req.body;
    
    try {
        // Create new tenant instance
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

        // If files are uploaded, upload them to Google Drive
        if (req.files.photo) {
            const photoFile = req.files.photo[0];
            const auth = await authenticate();
            const fileName = `${Date.now()}-${photoFile.originalname}`;
            const tempFilePath = path.join(__dirname, 'temp', fileName);
            fs.writeFileSync(tempFilePath, photoFile.buffer);

            const fileId = await uploadFileToGoogleDrive(auth, tempFilePath, fileName);
            fs.unlinkSync(tempFilePath);

            tenant.photo = `https://drive.google.com/uc?id=${fileId}`;
        }
        if (req.files.idProof) {
            const idProofFile = req.files.idProof[0];
            const auth = await authenticate();
            const fileName = `${Date.now()}-${idProofFile.originalname}`;
            const tempFilePath = path.join(__dirname, 'temp', fileName);
            fs.writeFileSync(tempFilePath, idProofFile.buffer);

            const fileId = await uploadFileToGoogleDrive(auth, tempFilePath, fileName);
            fs.unlinkSync(tempFilePath);

            tenant.idProof = `https://drive.google.com/uc?id=${fileId}`;
        }

        // Save tenant to the database
        await tenant.save();
        res.send('Tenant added successfully with images uploaded to Google Drive!');
    } catch (error) {
        console.error('Error adding tenant:', error);
        res.status(500).send('An error occurred while adding the tenant.');
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
