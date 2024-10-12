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
const { router, waitForUserResponse } = require('./routes/webhook');

//app.use('/signup', signupRoutes);
//app.use('/verify-otp', verifyOtpRoutes);
//app.use('/send-auth', sendAuthRoutes);
//app.use('/login', loginRoutes);
app.use('/webhook', router); // Ensure this is correctly linked to your `webhook.js` file


const Authorize = require('./models/Authorize'); // Import the Authorize model

console.log(waitForUserResponse);
app.get('/addproperty/:id', async (req, res) => {
    const id = req.params.id;

    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = authorizeRecord.phoneNumber; // Get the phone number from the record

        await sendWhatsAppAuthMessage(phoneNumber);
        
        const userResponse = await waitForUserResponse(phoneNumber); // This should now work

        if (userResponse.toLowerCase() === 'yes_authorize') {
            res.send(`
                <html>
                <body>
                    <h2>Add Property Details</h2>
                    <form action="/addproperty/${id}" method="POST" enctype="multipart/form-data">
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
            res.send('<h1>Access Denied</h1>');
        }
    } catch (error) {
        console.error('Error during authorization or fetching phone number:', error);
        res.status(500).send('An error occurred during authorization.');
    }
});

// Simulate user response handling (In reality, this should be a webhook listening for WhatsApp replies)
async function sendWhatsAppAuthMessage(phoneNumber) {
    return axios.post(process.env.WHATSAPP_API_URL, {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: {
                text: 'Do you authorize this action?'
            },
            action: {
                buttons: [
                    {
                        type: 'reply',
                        reply: {
                            id: 'Yes_authorize',
                            title: 'Yes'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'No_authorize',
                            title: 'No'
                        }
                    }
                ]
            }
        }
    }, {
        headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
        },
    });
}


// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
