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

// Dropbox instance
const dbx = new Dropbox({ accessToken: process.env.DROPBOX_ACCESS_TOKEN, fetch: fetch });

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

        // Fetch properties to associate the unit with a property
        const properties = await Property.find().select('name _id');

        // Render the add unit form and pass properties for selection
        res.render('addUnit', { id, properties });
    } catch (error) {
        console.error('Error during authorization or fetching properties:', error);
        res.status(500).send('An error occurred while fetching data.');
    }
});


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
        // Find authorization record by ID to get the phone number
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = '+' + authorizeRecord.phoneNumber;
       console.log(phoneNumber);

        // Find the user by phone number
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
            userId: user._id // Reference to the users collection
        });

        await property.save();

        if (req.file) {
            const dropboxPath = '/images/' + Date.now() + '-' + req.file.originalname;

            // Upload image to Dropbox
            const dropboxResponse = await dbx.filesUpload({
                path: dropboxPath,
                contents: req.file.buffer
            });

            const sharedLinkResponse = await dbx.sharingCreateSharedLinkWithSettings({
                path: dropboxResponse.result.path_lower
            });

            const imageUrl = sharedLinkResponse.result.url.replace('dl=0', 'raw=1');

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
        // Find authorization record by ID to get the phone number
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = '+' + authorizeRecord.phoneNumber;

        // Find the user by phone number
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
            userId: user._id // Reference to the users collection
        });

        await unit.save();

        if (req.file) {
            const dropboxPath = '/images/' + Date.now() + '-' + req.file.originalname;
            const dropboxResponse = await dbx.filesUpload({
                path: dropboxPath,
                contents: req.file.buffer
            });

            const sharedLinkResponse = await dbx.sharingCreateSharedLinkWithSettings({
                path: dropboxResponse.result.path_lower
            });

            const imageUrl = sharedLinkResponse.result.url.replace('dl=0', 'raw=1');

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
        // Find authorization record by ID to get the phone number
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = '+' + authorizeRecord.phoneNumber;

        // Find the user by phone number
        const user = await User.findOne({ phoneNumber });
        if (!user) {
            return res.status(404).send('User not found.');
        }

        // Create new tenant and reference the user by their ID
        const tenant = new Tenant({
            name,
            phoneNumber: user.phoneNumber, // Store tenant's phone number
            userId: user._id, // Reference to the users collection
            propertyName,
            unitAssigned,
            lease_start: new Date(lease_start),
            deposit,
            rent_amount,
            tenant_id,
        });

        // If files are uploaded, save their paths in Dropbox
        if (req.files.photo) {
            const photoPath = '/images/' + Date.now() + '-' + req.files.photo[0].originalname;
            const dropboxResponse = await dbx.filesUpload({
                path: photoPath,
                contents: req.files.photo[0].buffer
            });

            const sharedLinkResponse = await dbx.sharingCreateSharedLinkWithSettings({
                path: dropboxResponse.result.path_lower
            });

            tenant.photo = sharedLinkResponse.result.url.replace('dl=0', 'raw=1');
        }

        if (req.files.idProof) {
            const idProofPath = '/images/' + Date.now() + '-' + req.files.idProof[0].originalname;
            const dropboxResponse = await dbx.filesUpload({
                path: idProofPath,
                contents: req.files.idProof[0].buffer
            });

            const sharedLinkResponse = await dbx.sharingCreateSharedLinkWithSettings({
                path: dropboxResponse.result.path_lower
            });

            tenant.idProof = sharedLinkResponse.result.url.replace('dl=0', 'raw=1');
        }

        // Save tenant to the database
        await tenant.save();
        res.send('Tenant added successfully!');
    } catch (error) {
        console.error('Error adding tenant:', error);
        res.status(500).send('An error occurred while adding the tenant.');
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});



