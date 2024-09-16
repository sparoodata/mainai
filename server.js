const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const session = require('express-session'); // Import session middleware
const MongoStore = require('connect-mongo');
const app = express();
const port = 3000;
const User = require('./models/User'); 

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const mongoose = require('mongoose');

// MongoDB connection
mongoose.connect('mongodb+srv://ece1saikumar:hyaDfmoR4xRStmYe@tenants.orhtp.mongodb.net/?retryWrites=true&w=majority&appName=Tenants', {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch((error) => console.error('MongoDB connection error:', error));


app.use(session({
    secret: 'yourStrongSecretKey',
    resave: false,
    saveUninitialized: true,
    store: MongoStore.create({
        mongoUrl: 'mongodb+srv://ece1saikumar:hyaDfmoR4xRStmYe@tenants.orhtp.mongodb.net/?retryWrites=true&w=majority&appName=Tenants' // Replace with your MongoDB connection string
    }),
    cookie: {
        httpOnly: true,
        secure: false,  // Set to true if using HTTPS in production
        maxAge: 3600000  // 1 hour
    }
}));
// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN; // Replace with your access token
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // Replace with your verify token

app.post('/signup', async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = Date.now().toString(); // Generate a unique session ID

    try {
        // Check if the user already exists
        const existingUser = await User.findOne({ phoneNumber });

        if (existingUser) {
            // If user already exists, send a WhatsApp message
            try {
                const response = await axios.post(WHATSAPP_API_URL, {
                    messaging_product: 'whatsapp',
                    to: phoneNumber,
                    type: 'template',
                    template: {
                        name: 'onboard',  // Create a new template for this
                        language: { code: 'en' }
                    }
                }, {
                    headers: {
                        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });

                console.log('User already registered, message sent:', response.data);
                return res.json({ message: 'User already registered', sessionId });
            } catch (error) {
                console.error('Failed to send message:', error);
                return res.status(500).json({ error: 'Failed to notify user' });
            }
        }

        // If user doesn't exist, create a new entry and send OTP via WhatsApp
        const newUser = new User({ phoneNumber });
        await newUser.save(); // Save the new user to MongoDB

        // Send OTP to WhatsApp for new user registration
        const response = await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'template',
            template: {
                name: 'otp',  // Create a new template for OTP
                language: { code: 'en' }
            }
        }, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('OTP sent successfully:', response.data);
        res.json({ message: 'OTP sent', sessionId });

    } catch (error) {
        console.error('Signup failed:', error);
        res.status(500).json({ error: 'Signup failed' });
    }
});

// Serve static files
app.use(express.static('public'));

let sessions = {}; // Temporary storage for auth status

// Webhook verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === VERIFY_TOKEN) {
        console.log('Webhook verified successfully!');
   //     res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Send WhatsApp Authentication Request
app.post('/send-auth', async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = Date.now().toString(); // Generate a unique session ID

    sessions[sessionId] = { phoneNumber, status: 'pending' }; // Track session

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

// Webhook callback for OTP verification
app.post('/webhook', async (req, res) => {
    const { entry } = req.body;
    if (entry && entry.length > 0) {
        const changes = entry[0].changes;
        if (changes && changes.length > 0) {
            const messages = changes[0].value.messages;
            if (messages && messages.length > 0) {
                const message = messages[0];
                const phoneNumber = message.from.replace(/^\+/, ''); // Remove '+' prefix
                const payload = message.button ? message.button.payload : null;

                if (payload === 'OTP_verified') {  // Assuming the button is used for verification
                    const user = await User.findOne({ phoneNumber });

                    if (user) {
                        user.verified = true; // Mark user as verified
                        await user.save();
                        console.log('User verified:', phoneNumber);

                        // Set the session data
                        req.session.user = { phoneNumber, sessionId: Date.now().toString() };

                        return res.status(200).json({ status: 'verified' });
                    }
                } else if (payload === 'OTP_failed') {
                    console.log('OTP verification failed for', phoneNumber);
                }
            }
        }
    }
    res.sendStatus(200);
});



// Webhook callback for authentication
app.post('/webhook', (req, res) => {
    const { entry } = req.body;
    if (entry && entry.length > 0) {
        const changes = entry[0].changes;
        if (changes && changes.length > 0) {
            const messages = changes[0].value.messages;
            if (messages && messages.length > 0) {
                const message = messages[0];
                const phoneNumber = message.from.replace(/^\+/, ''); // Remove '+' prefix
                const payload = message.button ? message.button.payload : null;

                for (const [sessionId, session] of Object.entries(sessions)) {
                    if (session.phoneNumber.replace(/^\+/, '') === phoneNumber) {
                        if (payload === 'Yes') {
                            session.status = 'authenticated';
                            console.log('User authenticated successfully');

                            // Save session data in express session
                            req.session.user = { phoneNumber, sessionId };
                            console.log('Session after setting user:', req.session); // Log session details

                        } else if (payload === 'No') {
                            session.status = 'denied';
                            console.log('Authentication denied');
                        }
                        break;
                    }
                }
            }
        }
    }
    res.sendStatus(200);
});


// Authentication status check
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

// Dashboard route with secure access
app.get('/dashboard', (req, res) => {
    console.log('Dashboard session:', req.session);  // Log session details
    if (req.session.user && req.session.user.sessionId) {
        const { phoneNumber } = req.session.user;
        res.send(`<h1>Welcome to your Dashboard!</h1><p>Your phone number is ${phoneNumber}</p>`);
    } else {
        console.log('No valid session found, redirecting to access-denied');
        res.redirect('/access-denied');  // Redirect if no session found
    }
});


// Access denied route
app.get('/access-denied', (req, res) => {
    res.send('<h1>Access Denied</h1><p>You have been denied access.</p>');
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
