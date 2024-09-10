const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const session = require('express-session');
const crypto = require('crypto');
const app = express();
const port = 3000;

// Load environment variables from .env file
require('dotenv').config();

// Serve static files from the 'public' directory
app.use(express.static('public'));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Set up sessions
app.use(session({
    secret: process.env.SESSION_SECRET || 'your_secret_key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set secure to true if using HTTPS
}));

const sessions = {}; // To store session data

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN; // Use environment variable for WhatsApp access token
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN; // Use environment variable for webhook verify token

// Send WhatsApp Authentication Request
app.post('/send-auth', async (req, res) => {
    const { phoneNumber } = req.body;

    // Generate a unique session ID (could use a more robust approach)
    const sessionId = crypto.randomBytes(16).toString('hex');
    sessions[sessionId] = { phoneNumber, status: 'pending' };

    try {
        const response = await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'template',
            template: {
                name: 'authorize',
                language: { code: 'en' }
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
        console.error('Failed to send authentication message:', error);
        res.status(500).json({ error: 'Failed to send authentication message' });
    }
});

// Handle Webhook Callback
app.post('/webhook', (req, res) => {
    const { entry } = req.body;
    const webhookToken = req.headers['x-hub-signature'] || ''; // Webhook signature header

    console.log('Webhook Request Received:', req.body);

    // Verify webhook token
    if (webhookToken !== WEBHOOK_VERIFY_TOKEN) {
        return res.status(403).send('Forbidden');
    }

    if (entry && entry.length > 0) {
        const changes = entry[0].changes;
        if (changes && changes.length > 0) {
            const messages = changes[0].value.messages;
            if (messages && messages.length > 0) {
                const message = messages[0];
                const phoneNumber = message.from;
                const payload = message.button ? message.button.payload : null;

                // Find the session associated with the phone number
                for (const [sessionId, session] of Object.entries(sessions)) {
                    if (session.phoneNumber === phoneNumber) {
                        if (payload === 'Yes') {
                            session.status = 'authenticated';
                        } else if (payload === 'No') {
                            session.status = 'denied';
                        }
                        break;
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
        if (session.status === 'authenticated') {
            req.session.authenticated = true; // Set session variable for authentication
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

// Protect Dashboard Route
app.get('/dashboard', (req, res) => {
    if (req.session.authenticated) {
        res.sendFile(__dirname + '/public/dashboard.html'); // Serve the dashboard page
    } else {
        res.redirect('/login'); // Redirect to login page if not authenticated
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
