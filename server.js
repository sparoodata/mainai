const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const app = express();
const port = 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Configure session middleware
app.use(session({
    secret: 'your-secret-key', // Replace with a secure random string
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set `secure: true` if using HTTPS
}));

const sessions = {}; // To store session data

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN; // Replace with your access token
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // Replace with your verify token

// Serve static files from the public directory
app.use(express.static('public'));

// Webhook Verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === VERIFY_TOKEN) {
        // Respond with the challenge token from the request to verify the webhook
        console.log('Webhook verified successfully!');
        res.status(200).send(challenge);
    } else {
        // Respond with '403 Forbidden' if verification fails
        res.sendStatus(403);
    }
});

// Send WhatsApp Authentication Request
app.post('/send-auth', async (req, res) => {
    const { phoneNumber, countryCode } = req.body;

    // Remove the '+' prefix from phoneNumber
    const formattedPhoneNumber = phoneNumber.replace(/^\+/, '');

    // Generate a unique session ID
    const sessionId = Date.now().toString();
    sessions[sessionId] = { phoneNumber: formattedPhoneNumber, status: 'pending' };

    try {
        const response = await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: formattedPhoneNumber,
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
    console.log('Webhook Request Received:', req.body);

    if (entry && entry.length > 0) {
        const changes = entry[0].changes;
        if (changes && changes.length > 0) {
            const messages = changes[0].value.messages;
            if (messages && messages.length > 0) {
                const message = messages[0];
                const phoneNumber = message.from.replace(/^\+/, ''); // Remove the '+' prefix
                const payload = message.button ? message.button.payload : null;

                console.log('Received Payload:', payload);

                // Find the session associated with the phone number
                for (const [sessionId, session] of Object.entries(sessions)) {
                    if (session.phoneNumber === phoneNumber) {
                        if (payload === 'Yes') {
                            session.status = 'authenticated';
                            // Store sessionId in session cookie for tracking
                            req.session.authenticatedSessionId = sessionId;
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

// Dashboard route (to be shown after successful authentication)
app.get('/dashboard', (req, res) => {
    if (req.session.authenticatedSessionId) {
        const session = sessions[req.session.authenticatedSessionId];
        if (session && session.status === 'authenticated') {
            res.send('<h1>Welcome to your Dashboard!</h1><p>You have successfully logged in via WhatsApp authentication.</p>');
        } else {
            res.redirect('/');
        }
    } else {
        res.redirect('/');
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
