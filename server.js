require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const generateOTP = require('./utils/generateOTP'); // Utility to generate OTP
const User = require('./models/User'); 
const Tenant = require('./models/Tenant');

const app = express();
const port = 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set('trust proxy', 1);
mongoose.set('strictQuery', false);


// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch((error) => console.error('MongoDB connection error :', error));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI
    }),
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 3600000 // 1 hour
    }
}));

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Rate Limiter for Signup
const signupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: 'Too many signup attempts from this IP, please try again later.'
});

// Signup Route

// Serve static files
app.use(express.static('public'));

// Temporary storage for auth status (consider using a database for scalability)
let sessions = {};






// Authentication Status Check
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
        res.status(404).json({ status: 'not_found', message : 'Session not found' });
    }
});

// Login Route


// Export the router


app.get('/wa/:phone_no', (req, res) => {
  const phoneNo = req.params.phone_no.replace(/^\+/, '');
  const whatsappUrl = `https://wa.me/${phoneNo}?text=Hi`;
  
  // Redirect to WhatsApp link
  res.redirect(whatsappUrl);
});


// Logout Route
app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Failed to destroy session:', err);
            return res.status(500).json({ error: 'Failed to logout' });
        }
        res.clearCookie('connect.sid');
        res.json({ message: 'Logged out successfully' });
    });
});

const signupRoutes = require('./routes/signup');
app.use('/signup', signupRoutes);

const webhookRoutes = require('./routes/webhook');
app.use('/webhook', webhookRoutes); // For webhook routes

const verifyOtpRoutes = require('./routes/verify-otp');
app.use('/verify-otp', verifyOtpRoutes);

const sendAuthRoutes = require('./routes/send-auth');
app.use('/send-auth', sendAuthRoutes); 

const loginRoutes = require('./routes/login'); 
app.use('/login', loginRoutes);  

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});