const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const MongoStore = require('connect-mongo'); // To store sessions in MongoDB
const mongoose = require('mongoose');
const app = express();
const port = 3000;

// Load environment variables
require('dotenv').config();

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/yourdatabase';

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// Body parser middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Session configuration with MongoDB session store
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: MONGO_URI,
        collectionName: 'sessions'
    }),
    cookie: {
        secure: false, // Set to true if using HTTPS
        maxAge: 1000 * 60 * 60 * 24, // 1 day
    }
}));

// Log session data for debugging
app.use((req, res, next) => {
    console.log('Session ID:', req.sessionID);
    console.log('Session Data:', req.session);
    next();
});

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v17.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const sessions = {}; // Store session data temporarily in-memory

// Serve static files from the public directory
app.use(express.static('public'));

// Webhook Verification for WhatsApp
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === VERIFY_TOKEN) {
        console.log('Webhook verified successfully!');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Send WhatsApp Authentication Request
app.post('/send-auth', async (req, res) => {
    const { phoneNumber, countryCode } = req.body;

    // Concatenate the country code and phone number
    const formattedPhoneNumber = `${countryCode}${phoneNumber.replace(/^\+/, '')}`; // Strip '+' from phone number if included

    // Generate a unique session ID
    const sessionId = Date.now().toString();
    sessions[sessionId] = { phoneNumber: formattedPhoneNumber, status: 'pending' };

    try {
        const response = await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: formattedPhoneNumber,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: {
                    text: 'Do you authorize this login?'
                },
                action: {
                    buttons: [
                        {
                            type: 'reply',
                            reply: {
                                id: `yes_${sessionId}`,
                                title: 'Yes'
                            }
                        },
                        {
                            type: 'reply',
                            reply: {
                                id: `no_${sessionId}`,
                                title: 'No'
                            }
                        }
                    ]
                }
            }
        }, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('Message sent successfully:', response.data);
        res.json({ message: 'Authentication message sent', sessionId });
    } catch (error) {
        console.error('Failed to send authentication message:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'Failed to send authentication message' });
    }
});

// Handle Webhook Callback
app.post('/webhook', (req, res) => {
    const { entry } = req.body;

    if (entry && entry.length > 0) {
        const changes = entry[0].changes;
        if (changes && changes.length > 0) {
            const value = changes[0].value;
            const messages = value.messages;

            if (messages && messages.length > 0) {
                const message = messages[0];
                const phoneNumber = message.from.replace(/^\+/, ''); // Remove the '+' prefix

                let payload;
                if (message.button && message.button.payload) {
                    payload = message.button.payload; // For older API versions
                } else if (message.interactive && message.interactive.button_reply && message.interactive.button_reply.id) {
                    payload = message.interactive.button_reply.id; // For newer API versions
                }

                if (payload) {
                    // Extract action and sessionId from payload
                    const [action, sessionId] = payload.split('_');

                    if (sessions[sessionId]) {
                        if (action === 'yes') {
                            sessions[sessionId].status = 'authenticated';
                            req.session.authenticatedSessionId = sessionId;  // Save authenticated session ID
                            req.session.phoneNumber = phoneNumber;  // Save phone number in session

                            // Explicitly save the session to ensure it's written before redirecting
                            req.session.save((err) => {
                                if (err) {
                                    console.error('Error saving session:', err);
                                } else {
                                    console.log('User authenticated successfully:', phoneNumber);
                                    // Redirect to the dashboard
                                    res.redirect('/dashboard');
                                }
                            });
                        } else if (action === 'no') {
                            sessions[sessionId].status = 'denied';
                        }
                    } else {
                        console.log('Session not found for sessionId:', sessionId);
                    }
                }
            }
        }
    }

    res.sendStatus(200); // Respond to the webhook
});

// Check Authentication Status
app.get('/auth/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions[sessionId];

    if (session) {
        console.log('Checking session:', session);
        if (session.status === 'authenticated') {
            res.json({ status: 'authenticated', message: 'Login successful' });
        } else if (session.status === 'denied') {
            res.json({ status: 'denied', message: 'Access denied' });
        } else {
            res.json({ status: 'pending', message: 'Waiting for authorization' });
        }
    } else {
        res.status(404).json({ status: 'not_found', message: 'Session not found' });
    }
});

// Serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));  // Serve index.html from the public directory
});

// Dashboard route (protected)
app.get('/dashboard', (req, res) => {
    console.log('Session Data at /dashboard:', req.session);  // Debug the session data
    const phoneNumber = req.session.phoneNumber;
    if (phoneNumber) {
        res.send(`<h1>Welcome to your Dashboard!</h1><p>Your phone number: ${phoneNumber}</p>`);
    } else {
        res.send(`<h1>Session Data Missing!</h1><p>Phone number is undefined</p>`);
    }
});

// Access Denied route
app.get('/access-denied', (req, res) => {
    res.send('<h1>Access Denied</h1><p>You have been denied access.</p>');
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
