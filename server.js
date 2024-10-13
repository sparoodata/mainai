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
const { router, waitForUserResponse } = require('./routes/webhook');
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

        // Initially respond with a "waiting" message
        res.send(`
            <html>
            <body>
                <h2>Waiting for authorization from WhatsApp...</h2>
                <p>Please authorize the action in WhatsApp to proceed with adding the property.</p>
                <script>
                    // Poll the server every 5 seconds to check for authorization status
                    setInterval(async () => {
                        const response = await fetch('/checkAuthorization/${id}');
                        const result = await response.json();
                        if (result.status === 'authorized') {
                            window.location.reload(); // Reload the page to show the form
                        }
                    }, 5000);
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
app.get('/checkAuthorization/:id', async (req, res) => {
    const id = req.params.id;

    try {
        // Find the authorization record
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).json({ status: 'not_found' });
        }

        const phoneNumber = authorizeRecord.phoneNumber;

        // Check if the user response was 'Yes_authorize'
        const userResponses = await waitForUserResponse(phoneNumber);

        if (userResponses && userResponses.toLowerCase() === 'yes_authorize') {
            // Clear the response after successful authorization to prevent repeated checks
            delete userResponses[phoneNumber];

            res.json({ status: 'authorized' });
        } else {
            res.json({ status: 'waiting' });
        }
    } catch (error) {
        console.error('Error checking authorization status:', error);
        res.status(500).json({ status: 'error' });
    }
});

// POST route to handle the form submission after authorization
app.post('/addproperty/:id', async (req, res) => {
    // Your form submission logic here
    // You can access form data via req.body (e.g., req.body.name, req.body.units, etc.)
    res.send('Property added successfully!');
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
