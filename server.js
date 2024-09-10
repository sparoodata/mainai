const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const app = express();
const port = 3000;

// Load environment variables
require('dotenv').config();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const session = require('express-session');
const MongoStore = require('connect-mongo');
require('dotenv').config(); // If you're using dotenv to load environment variables

// Use MONGO_URI from environment variables
const mongoUri = process.env.MONGO_URI;

app.use(session({
  secret: 'your-secret-key',  // Replace with your session secret
  resave: false,
  saveUninitialized: false,   // Set to false to avoid storing uninitialized sessions
  store: new MongoStore({
    mongoUrl: mongoUri,
    ttl: 14 * 24 * 60 * 60 // Session expiration in seconds (14 days)
  })
}));


app.post('/login', (req, res) => {
  const { phoneNumber, authToken } = req.body;

  // Logic to authenticate the user
  if (authTokenIsValid) {
    req.session.phoneNumber = phoneNumber;
    req.session.status = 'authenticated';
    
    req.session.save(err => {
      if (err) {
        console.error("Error saving session:", err);
        return res.status(500).send("Error saving session");
      }
      return res.redirect('/dashboard');
    });
  } else {
    res.status(401).send("Invalid credentials");
  }
});

const sessions = {}; // Store session data

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v17.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Serve static files from the public directory
app.use(express.static('public'));

// Webhook Verification
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
    const formattedPhoneNumber = `${countryCode}${phoneNumber.replace(/^\+/, '')}`;

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

                console.log('Received Payload:', payload);

                if (payload) {
                    // Extract action and sessionId from payload
                    const [action, sessionId] = payload.split('_');

                    if (sessions[sessionId]) {
                        if (action === 'yes') {
                          
                          
                            sessions[sessionId].status = 'authenticated';
                            req.session.authenticatedSessionId = sessionId;  // Save authenticated session ID
                            req.session.phoneNumber = phoneNumber;  // Save phone number in session
                            console.log('User authenticated successfully:', phoneNumber);
                          
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

// Secure Dashboard Route
app.get('/dashboard', (req, res) => {
  if (req.session.status === 'authenticated') {
    res.send('Welcome to your dashboard');
  } else {
    res.redirect('/login');
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
