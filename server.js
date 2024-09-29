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


// Trust the first proxy (or set this to a higher number if you're behind multiple proxies)
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

// In-memory session tracking (you can later move this to MongoDB or Redis for scalability)
let sessions = {};

// Routes for sending auth and handling status checks
const signupRoutes = require('./routes/signup');
const verifyOtpRoutes = require('./routes/verify-otp');
const sendAuthRoutes = require('./routes/send-auth');
const loginRoutes = require('./routes/login');
const webhookRoutes = require('./routes/webhook');  // No need to duplicate this in server.js

app.use('/signup', signupRoutes);
app.use('/verify-otp', verifyOtpRoutes);
app.use('/send-auth', sendAuthRoutes);
app.use('/login', loginRoutes);
app.use('/webhook', webhookRoutes); // Ensure this is correctly linked to your `webhook.js` file

// Authentication Status Check Route
app.get('/auth/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions[sessionId];

    if (session) {
        if (session.status === 'authenticated') {
            res.json({ status: 'authenticated' });
        } else if (session.status === 'denied') {
            res.json({ status: 'denied' });
        } else {
            res.json({ status: 'pending' });
        }
    } else {
        res.status(404).json({ status: 'not_found' });
    }
});

app.use('/secure', express.static('public'));

app.get('/addproperty/:phoneNumber', async (req, res) => {
  const phoneNumber = req.params.phoneNumber;

  // Send WhatsApp message for authentication
  try {
    const response = await sendWhatsAppAuthMessage(phoneNumber);

    // Simulate waiting for user response (this should actually be handled asynchronously)
    const userResponse = await waitForUserResponse(phoneNumber); // Placeholder

    if (userResponse === 'Yes') {
      // If authorized, load secured HTML
      res.redirect('/secure/propertyform.html');
    } else {
      res.status(401).send('Unauthorized');
    }
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    res.status(500).send('Something went wrong');
  }
});

// Function to send WhatsApp message using the provided API structure
async function sendWhatsAppAuthMessage(phoneNumber) {
  return axios.post(process.env.WHATSAPP_API_URL, {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'template',
    template: {
      name: 'authorize', // Ensure this template exists in your WhatsApp Business Account
      language: { code: 'en' },
    },
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// Simulate user response handling (In reality, this should be a webhook listening for WhatsApp replies)
async function waitForUserResponse(phoneNumber) {
  return new Promise((resolve) => {
    setTimeout(() => {
      // Simulated user response, should be handled through WhatsApp Webhook
      resolve('Yes'); // Simulating an authorized user response
    }, 5000); // Simulating 5 seconds for response
  });
}


// Dashboard route (protected)
app.get('/dashboard', (req, res) => {
    if (!req.session.phoneNumber) {
        return res.redirect('/login'); // Redirect to login if session doesn't exist
    }

    res.send(`Welcome to the dashboard, ${req.session.phoneNumber}`);
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
