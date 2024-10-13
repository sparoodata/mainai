require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const path = require('path');
const axios = require("axios");

const app = express();
const port = process.env.PORT || 3000; // Glitch uses dynamic port

// Trust the first proxy
app.set('trust proxy', 1);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// MongoDB connection
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

// Routes and webhook handling
const { router, waitForUserResponse, userResponses } = require('./routes/webhook'); // Import userResponses
app.use('/webhook', router); // Link to webhook.js

const Authorize = require('./models/Authorize'); // Import the Authorize model

// Add property route that waits for WhatsApp authorization
app.get('/addproperty/:id', async (req, res) => {
    const id = req.params.id;

    try {
        // Find the authorization record in the 'authorizes' collection
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = authorizeRecord.phoneNumber;

        // Send the WhatsApp authorization message
        await sendWhatsAppAuthMessage(phoneNumber);

        // Respond with an HTML page that includes the client-side polling script
        res.send(`
  <html>
            <head>
                <link rel="stylesheet" type="text/css" href="/styles.css">
            </head>
            <body>
                <div class="container">
                    <h2>Waiting for WhatsApp Authorization...</h2>
                    <p>Please authorize the action in WhatsApp to proceed with adding the property.</p>
                </div>

                <script>
                    const pollAuthorizationStatus = async () => {
                        try {
                            console.log("Polling started...");
                            const response = await fetch('/checkAuthorization/${id}', {
                                headers: { 'Accept': 'application/json' } // Request JSON response
                            });

                            const contentType = response.headers.get("content-type");

                            if (contentType && contentType.indexOf("application/json") !== -1) {
                                const result = await response.json();
                                console.log("Polling result:", result);

                                if (result.status === 'authorized') {
                                    console.log("Authorization successful, reloading page...");
                                    window.location.reload();  // Page reload to show form when authorized
                                } else if (result.status === 'waiting') {
                                    console.log("Still waiting for authorization...");
                                }
                            } else {
                                console.log("Received HTML form, stopping polling...");
                                document.documentElement.innerHTML = await response.text(); // Replace the current page with the HTML form
                            }
                        } catch (error) {
                            console.error('Error checking authorization status:', error);
                        }
                    };

                    // Set the polling interval to run every 5 seconds
                    setInterval(pollAuthorizationStatus, 5000);
                </script>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Error during authorization or fetching phone number:', error);
        res.status(500).send('An error occurred during authorization.');
    }
});

// Separate endpoint to check the authorization status
// Separate endpoint to check the authorization status
app.get('/checkAuthorization/:id', async (req, res) => {
    const id = req.params.id;

    try {
        // Find the authorization record
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = authorizeRecord.phoneNumber;

        // Check if the user response was 'Yes_authorize'
        const userResponse = await waitForUserResponse(phoneNumber);
        console.log(`User response for ${phoneNumber}:`, userResponse);

        if (userResponse && userResponse.toLowerCase() === 'yes_authorize') {
            console.log("User authorized the action.");
            // Clear the response after successful authorization
            delete userResponses[phoneNumber];

            // Render the HTML form for adding the property
// Add enctype for file upload in the form
res.send(`
    <html>
    <head>
        <link rel="stylesheet" type="text/css" href="/styles.css">
    </head>
    <body>
        <div class="container">
            <h2>Authorization successful! Add your property below:</h2>
            <form action="/addproperty/${id}" method="POST" enctype="multipart/form-data">
                <label for="property_name">Property Name:</label>
                <input type="text" id="property_name" name="property_name" required><br><br>

                <label for="units">Number of Units:</label>
                <input type="number" id="units" name="units" required><br><br>

                <label for="address">Address:</label>
                <input type="text" id="address" name="address" required><br><br>

                <label for="totalAmount">Total Amount:</label>
                <input type="number" id="totalAmount" name="totalAmount" required><br><br>

                <label for="image">Property Image:</label>
                <input type="file" id="image" name="image" required><br><br>

                <button type="submit">Submit</button>
            </form>
        </div>
    </body>
    </html>
`);

        } else {
            console.log("Still waiting for authorization.");
            return res.json({ status: 'waiting' });
        }
    } catch (error) {
        console.error('Error checking authorization status:', error);
        res.status(500).send('An error occurred while checking authorization.');
    }
});


const multer = require('multer');
const Image = require('./models/Image'); // Import Image model
const Property = require('./models/Property'); // Import Property model

// Configure multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/'); // Folder where images will be saved
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname); // Unique file names
    }
});

const upload = multer({ storage: storage });

// Handle form submission and image upload
app.post('/addproperty/:id', upload.single('image'), async (req, res) => {
    const { property_name, units, address, totalAmount } = req.body;

    try {
        // Save the property data to MongoDB
        const property = new Property({
            name: property_name,
            units,
            address,
            totalAmount,
        });

        await property.save();

        // Save the image data to the 'images' collection
        if (req.file) {
            const image = new Image({
                propertyId: property._id,
                imageUrl: '/uploads/' + req.file.filename,
                imageName: req.file.originalname,
            });

            await image.save();

            // Link the image to the property
            property.images.push(image._id);
            await property.save();
        }

        res.send('Property and image added successfully!');
    } catch (error) {
        console.error('Error adding property and image:', error);
        res.status(500).send('An error occurred while adding the property and image.');
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
            body: {
                text: 'Do you authorize this action?'
            },
            action: {
                buttons: [
                    {
                        type: 'reply',
                        reply: {
                            id: 'Yes_authorize',
                            title: 'Yes'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'No_authorize',
                            title: 'No'
                        }
                    }
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

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
