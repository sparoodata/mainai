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
            <body>
                <h2>Waiting for authorization from WhatsApp...</h2>
                <p>Please authorize the action in WhatsApp to proceed with adding the property.</p>
       <script>
    const pollAuthorizationStatus = async () => {
        try {
            console.log("Polling started...");
            const response = await fetch('/checkAuthorization/${id}');
            const result = await response.json();
            console.log("Polling result:", result);

            if (result.status === 'authorized') {
                console.log("Authorization successful, reloading page...");
                window.location.reload();
            } else if (result.status === 'waiting') {
                console.log("Still waiting for authorization...");
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
            return res.status(404).json({ status: 'not_found' });
        }

        const phoneNumber = authorizeRecord.phoneNumber;

        // Check if the user response was 'Yes_authorize'
        const userResponse = await waitForUserResponse(phoneNumber);

        if (userResponse && userResponse.toLowerCase() === 'yes_authorize') {
            // Clear the response after successful authorization to prevent repeated checks
            delete userResponses[phoneNumber];

            // Render the HTML form for adding the property
            res.send(`
                <html>
                <body>
                    <h2>Authorization successful! Add your property below:</h2>
                    <form action="/addproperty/${id}" method="POST">
                        <label for="property_name">Property Name:</label>
                        <input type="text" id="property_name" name="property_name" required><br><br>
                        <label for="units">Number of Units:</label>
                        <input type="number" id="units" name="units" required><br><br>
                        <label for="image">Property Image URL:</label>
                        <input type="url" id="image" name="image"><br><br>
                        <button type="submit">Submit</button>
                    </form>
                </body>
                </html>
            `);
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
