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
app.post('/signup', signupLimiter, [
    body('phoneNumber').isMobilePhone().withMessage('Invalid phone number')
], async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = Date.now().toString(); // Generate a unique session ID

    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    try {
        // Check if the user already exists
        const existingUser = await User.findOne({ phoneNumber });

        if (existingUser) {
            if (existingUser.verified) {
                // User is already verified
                try {
                const response = await axios.post(WHATSAPP_API_URL, {
                    messaging_product: 'whatsapp',
                    to: phoneNumber,
                    type: 'template',
                    template: {
                        name: 'userexists',
                        language: { code: 'en' }
                    }
                }, {
                    headers: {
                        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });

                    console.log('User already registered and verified, message sent:', response.data);
                    return res.json({ message: 'User already registered and verified', sessionId });
                } catch (error) {
                    console.error('Failed to send message:', error.response ? error.response.data : error);
                    return res.status(500).json({ error: 'Failed to notify user' });
                }
            } else {
                // User exists but not verified, resend OTP
                const otp = generateOTP();
                existingUser.otp = otp;
                existingUser.otpExpiresAt = Date.now() + 10 * 60 * 1000; // OTP valid for 10 minutes
                await existingUser.save();

                // Send OTP via WhatsApp
                const response = await axios.post(WHATSAPP_API_URL, {
                    messaging_product: 'whatsapp',
                    to: phoneNumber,
                    type: 'template',
                    template: {
                        name: 'onboard_otp',
                        language: { code: 'en' },
                        components: [
                            {
                                type: 'body',
                                parameters: [
                                    { type: 'text', text: otp }
                                ]
                            }
                        ]
                    }
                }, {
                    headers: {
                        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });

                console.log('OTP resent successfully:', response.data);
                return res.json({ message: 'OTP resent', sessionId });
            }
        }

        // If user doesn't exist, create a new entry and send OTP via WhatsApp
        const otp = generateOTP();
        const newUser = new User({
            phoneNumber,
            otp,
            otpExpiresAt: Date.now() + 10 * 60 * 1000 // OTP valid for 10 minutes
        });
        await newUser.save(); // Save the new user to MongoDB

        // Send OTP to WhatsApp for new user registration
        const response = await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'template',
            template: {
                name: 'onboard_otp',
                language: { code: 'en' },
                components: [
                    {
                        type: 'body',
                        parameters: [
                            { type: 'text', text: otp }
                        ]
                    }
                ]
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
        console.error('Signup failed:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'Signup failed' });
    }
});

// Serve static files
app.use(express.static('public'));

// Temporary storage for auth status (consider using a database for scalability)
let sessions = {};

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

// Unified Webhook Callback
app.post('/webhook', async (req, res) => {
    const { entry } = req.body;

    if (entry && entry.length > 0) {
        const changes = entry[0].changes;
        if (changes && changes.length > 0) {
            const messages = changes[0].value.messages;
            if (messages && messages.length > 0) {
                const message = messages[0];
                const phoneNumber = message.from.replace(/^\+/, ''); // Remove '+' prefix
                const text = message.text ? message.text.body.trim() : null;
                const payload = message.button ? message.button.payload : null;
                const text1 = message.button ? message.button.text : null;
              console.log(messages);

                // Handle OTP Verification
                if (text && /^\d{6}$/.test(text)) { // Check if the message is a 6-digit OTP
                    try {
                        const user = await User.findOne({ phoneNumber });

                        if (user && user.otp === text && user.otpExpiresAt > Date.now()) {
                            user.verified = true;
                            user.otp = undefined;
                            user.otpExpiresAt = undefined;
                            await user.save();

                            console.log('User verified via WhatsApp:', phoneNumber);

                            // Send confirmation message
                            await axios.post(WHATSAPP_API_URL, {
                                messaging_product: 'whatsapp',
                                to: phoneNumber,
                                type: 'template',
                                template: {
                                    name: 'otp_success',  // Ensure this template exists
                                    language: { code: 'en' }
                                }
                            }, {
                                headers: {
                                    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                    'Content-Type': 'application/json'
                                }
                            });

                        } else {
                            console.log('Invalid or expired OTP for:', phoneNumber);
                            // Send failure message
                            await axios.post(WHATSAPP_API_URL, {
                                messaging_product: 'whatsapp',
                                to: phoneNumber,
                                type: 'template',
                                template: {
                                    name: 'otp_failure',  // Ensure this template exists
                                    language: { code: 'en' }
                                }
                            }, {
                                headers: {
                                    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                    'Content-Type': 'application/json'
                                }
                            });
                        }
                    } catch (error) {
                        console.error('Error verifying OTP:', error.response ? error.response.data : error);
                    }
                }

                // Handle Authentication Payloads
                if (payload) {
                    for (const [sessionId, session] of Object.entries(sessions)) {
                        if (session.phoneNumber.replace(/^\+/, '') === phoneNumber) {
                            if (payload === 'Yes') {
                                session.status = 'authenticated';
                                console.log('User authenticated successfully');

                                // Save session data in express session
                                req.session.user = { phoneNumber, sessionId };
                                console.log('Session after setting user:', req.session);

                                // Optionally, send a success message
                                // await axios.post(WHATSAPP_API_URL, {
                                //     messaging_product: 'whatsapp',
                                //     to: phoneNumber,
                                //     type: 'template',
                                //     template: {
                                //         name: 'auth_success',  // Ensure this template exists
                                //         language: { code: 'en' }
                                //     }
                                // }, {
                                //     headers: {
                                //         'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                //         'Content-Type': 'application/json'
                                //     }
                                // });

                            } else if (payload === 'No') {
                                session.status = 'denied';
                                console.log('Authentication denied');

                                // Optionally, send a denial message
                                await axios.post(WHATSAPP_API_URL, {
                                    messaging_product: 'whatsapp',
                                    to: phoneNumber,
                                    type: 'template',
                                    template: {
                                        name: 'auth_denied',  // Ensure this template exists
                                        language: { code: 'en' }
                                    }
                                }, {
                                    headers: {
                                        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                        'Content-Type': 'application/json'
                                    }
                                });
                            }
                            break;
                        }
                    }
                }

                // Handle Rent Payment Payload
                if (text1 === 'Rent paid') {
                    // Extract tenant_id from the message text or payload
                    const tenantId = payload.split('-')[1].split(' ')[0]; // Assuming tenant_id is sent in the message text
                    console.log(tenantId);
                    try {
                        const tenant = await Tenant.findOne({ tenant_id: tenantId });

                        if (tenant) {
                            tenant.status = 'PAID';
                            await tenant.save();

                            console.log('Tenant rent status updated to PAID:', tenantId);
let extractedPart = payload.match(/[A-Za-z]+-T\d+/)[0]; 
                            // Optionally, send a confirmation message
await axios.post(WHATSAPP_API_URL, {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'text',
    text: {
        body: `*${extractedPart}* marked as PAID 🙂👍`
    }
}, {
    headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
    }
});


                        } else {
                            console.log('Tenant not found for tenant_id:', tenantId);
                        }
                    } catch (error) {
                        console.error('Error updating rent status:', error.response ? error.response.data : error);
                    }
                }
            }
        }
    }

    res.sendStatus(200);
});


// Verify OTP Route
app.post('/verify-otp', [
    body('phoneNumber').isMobilePhone().withMessage('Invalid phone number'),
    body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
], async (req, res) => {
    const { phoneNumber, otp } = req.body;
  console.log(req.body);
     
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    try {
        // Find the user by phone number
        const user = await User.findOne({ phoneNumber });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Check if the OTP matches and is not expired
        if (user.otp === otp && user.otpExpiresAt > Date.now()) {
            // OTP is valid, mark the user as verified
            user.verified = true;
            user.otp = undefined; // Remove the OTP
            user.otpExpiresAt = undefined; // Remove OTP expiration time
            await user.save();

            console.log('User verified successfully:', phoneNumber);

            // Optionally send a success message to WhatsApp
            await axios.post(WHATSAPP_API_URL, {
                messaging_product: 'whatsapp',
                to: phoneNumber,
                type: 'template',
                template: {
                    name: 'registration_success',  // Ensure this template exists
                    language: { code: 'en' }
                }
            }, {
               headers: {
                    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });

            return res.json({ message: 'User verified successfully' });
        } else {
            console.log('Invalid or expired OTP for:', phoneNumber);

         

            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }
    } catch (error) {
        console.error('Error verifying OTP:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'OTP verification failed' });
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
                name: 'authorize', // Ensure this template exists
                language: { code: 'en' }
            }
        }, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('Authentication message sent successfully:', response.data);
        res.json({ message: 'Authentication message sent', sessionId });
    } catch (error) {
        console.error('Failed to send authentication message:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'Failed to send authentication message' });
    }
});

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
app.post('/login', async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = Date.now().toString();

    // Check if the user exists and is verified
    try {
        const user = await User.findOne({ phoneNumber });

        if (!user) {
            // Phone number not registered
            return res.status(404).json({ error: 'Phone number not registered. Please sign up.' });
        }

        if (user && user.verified) {
            // User is verified, send WhatsApp authentication message
            sessions[sessionId] = { phoneNumber, status: 'pending' };

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

            console.log('Authentication message sent successfully:', response.data);
            res.json({ message: 'Authentication message sent', sessionId });
        } else {
            res.status(403).json({ error: 'User not verified. Please verify your account.' });
        }
    } catch (error) {
        console.error('Login failed:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'Login failed' });
    }
});

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

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});