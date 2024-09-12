const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const Session = require('./models/Session');
const cookieParser = require('cookie-parser');

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

// Use session middleware
app.use(
  session({
    secret: 'yourSecret', // Make sure this is a secure secret
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: 'mongodb://localhost:27017/yourDBName', // Replace with your MongoDB connection string
      collectionName: 'sessions', // Make sure it's the same collection where sessions are stored
    }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24, // 24 hours
      httpOnly: true, // For security reasons
    },
  })
);


// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v17.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

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
    const formattedPhoneNumber = `${countryCode}${phoneNumber.replace(/^\+/, '')}`;
    const sessionId = Date.now().toString();

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
                        { type: 'reply', reply: { id: `yes_${sessionId}`, title: 'Yes' } },
                        { type: 'reply', reply: { id: `no_${sessionId}`, title: 'No' } }
                    ]
                }
            }
        }, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        const newSession = new Session({ sessionId, phoneNumber: formattedPhoneNumber, status: 'pending' });
        await newSession.save();

        console.log('Message sent successfully:', response.data);
        res.json({ message: 'Authentication message sent', sessionId });
    } catch (error) {
        console.error('Failed to send authentication message:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'Failed to send authentication message' });
    }
});

// Handle Webhook Callback
// Handle Webhook Callback
app.post('/webhook', async (req, res) => {
    const { entry } = req.body;

    if (entry && entry.length > 0) {
        const changes = entry[0].changes;
        if (changes && changes.length > 0) {
            const value = changes[0].value;
            const messages = value.messages;

            if (messages && messages.length > 0) {
                const message = messages[0];
                const phoneNumber = message.from.replace(/^\+/, '');
                let payload;

                if (message.interactive && message.interactive.button_reply && message.interactive.button_reply.id) {
                    payload = message.interactive.button_reply.id;
                }

                if (payload) {
                    const [action, sessionId] = payload.split('_');

                    try {
                        const session = await Session.findOne({ sessionId });

                        if (session) {
                            if (action === 'yes') {
                                session.status = 'authenticated';
                                await session.save();

                                // Set session data
                             
                                req.session.authenticatedSessionId = sessionId;
                                console.log('authentic_id',req.session.authenticatedSessionId);
                                req.session.phoneNumber = phoneNumber;

                                // Save session
                                req.session.save((err) => {
                                    if (err) {
                                        console.error('Error saving session:', err);
                                        return res.status(500).send('Internal Server Error');
                                    } else {
                                        console.log('Session saved successfully:', req.session);
                                        res.status(200).send(); // Send a response once
                                    }
                                });
                            } else if (action === 'no') {
                                session.status = 'denied';
                                await session.save();
                            }
                        } else {
                            console.log('Session not found for sessionId:', sessionId);
                        }
                    } catch (error) {
                        console.error('Error handling session:', error);
                        return res.status(500).send('Internal Server Error');
                    }
                }
            }
        }
    }

    res.sendStatus(200); // Ensure response is only sent once
});

// Check Authentication Status
app.get('/auth/status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    try {
        const session = await Session.findOne({ sessionId });
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
    } catch (error) {
        console.error('Error retrieving session:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Dashboard route (protected)
// Dashboard route (protected)
app.use(cookieParser());
// Dashboard route (protected)
app.get('/dashboard', async (req, res) => {
  try {
    const sessionIdFromCookie = req.cookies['connect.sid']; // Get session ID from the cookie

    console.log('Session ID from cookie:', sessionIdFromCookie); // Log for debugging

    if (!sessionIdFromCookie) {
      return res.redirect('/access-denied'); // If no session ID found in the cookie
    }

    // Find the session in MongoDB
    const session = await mongoose.connection.db.collection('sessions').findOne({ _id: sessionIdFromCookie });

    if (!session) {
      console.log('Session not found in MongoDB');
      return res.redirect('/access-denied');
    }

    console.log('Session found in MongoDB:', session);

    const sessionData = JSON.parse(session.session);

    if (sessionData.authenticatedSessionId) {
      return res.send(`<h1>Welcome to your Dashboard!</h1><p>Your session ID: ${sessionData.authenticatedSessionId}</p>`);
    } else {
      return res.redirect('/access-denied');
    }
  } catch (error) {
    console.error('Error retrieving session:', error);
    res.status(500).send('Internal Server Error');
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
