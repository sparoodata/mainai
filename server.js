require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const path = require('path');
const axios = require("axios"); 
const multer = require('multer');



const app = express();
const port = process.env.PORT || 3000; // Glitch uses dynamic port


// Trust the first proxy (or set this to a higher number if you're behind multiple proxies)
app.set('trust proxy', 1);
// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

async function waitForUserResponse(phoneNumber) {
    // In reality, this should be handled via a webhook for WhatsApp responses
    return new Promise((resolve) => {
        setTimeout(() => {
            // Simulated user response, should be handled through WhatsApp Webhook
            resolve('Yes'); // Simulating an authorized user response
        }, 5000); // Simulating 5 seconds for response
    });
}

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
// const signupRoutes = require('./routes/signup');
// const verifyOtpRoutes = require('./routes/verify-otp');
// const sendAuthRoutes = require('./routes/send-auth');
// const loginRoutes = require('./routes/login');
 const webhookRoutes = require('./routes/webhook');  // No need to duplicate this in server.js


//app.use('/signup', signupRoutes);
//app.use('/verify-otp', verifyOtpRoutes);
//app.use('/send-auth', sendAuthRoutes);
//app.use('/login', loginRoutes);
app.use('/webhook', webhookRoutes); // Ensure this is correctly linked to your `webhook.js` file

router.get('/addproperty/:phoneNumber', async (req, res) => {
    const phoneNumber = req.params.phoneNumber;

    // Send authorization request to WhatsApp
    try {
        await sendWhatsAppAuthMessage(phoneNumber);
        
        // Wait for the user's response (should be handled via a webhook in a real implementation)
        const userResponse = await waitForUserResponse(phoneNumber);
        
        // If the user says "Yes", show the form
        if (userResponse.toLowerCase() === 'yes') {
            res.send(`
                <html>
                <body>
                    <h2>Add Property Details</h2>
                    <form action="/addproperty/${phoneNumber}" method="POST" enctype="multipart/form-data">
                        <label>Property Name:</label>
                        <input type="text" name="name" required /><br/>
                        <label>Number of Units:</label>
                        <input type="number" name="units" required /><br/>
                        <label>Address:</label>
                        <input type="text" name="address" required /><br/>
                        <label>Total Amount:</label>
                        <input type="number" name="totalAmount" required /><br/>
                        <label>Upload Image:</label>
                        <input type="file" name="image" accept="image/*" required /><br/>
                        <button type="submit">Add Property</button>
                    </form>
                </body>
                </html>
            `);
        } else {
            // If user denies authorization
            res.send('<h1>Access Denied</h1>');
        }
    } catch (error) {
        console.error('Error sending WhatsApp authorization or waiting for response:', error);
        res.status(500).send('An error occurred during authorization.');
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


// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
