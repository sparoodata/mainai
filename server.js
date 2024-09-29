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

// In-memory store for authenticated users (use a DB in production)

// In-memory store for authenticated users (use a DB in production)
const authenticatedUsers = {};

// Multer for file uploads
const upload = multer({ dest: 'uploads/' });



// Define the Property schema and model
const propertySchema = new mongoose.Schema({
  propertyName: String,
  address: String,
  image: String, // Store the file path or URL
  units: Number
});

const Property = mongoose.model('Property', propertySchema);

// Route to show "Waiting for Authentication" page
app.get('/addproperty/:phoneNumber', (req, res) => {
  const phoneNumber = req.params.phoneNumber;

  console.log(`Authentication initiated for ${phoneNumber}`);

  // Send WhatsApp message for authentication
  sendWhatsAppAuthMessage(phoneNumber);

  res.sendFile(__dirname + '/public/waiting.html'); // Display waiting page
});

// Webhook to receive WhatsApp response
app.post('/webhook', (req, res) => {
  const message = req.body;

  console.log('Received webhook payload:', JSON.stringify(message)); // Log incoming webhook payload

  const phoneNumber = message.from; // Update this based on actual webhook structure
  const userMessage = message.button?.text || '';
  console.log(userMessage);
  // Check if the user replied "Yes"
  if (userMessage.trim().toLowerCase() === 'yes') {
    console.log(`User ${phoneNumber} authorized via WhatsApp.`);
    authenticatedUsers[phoneNumber] = true; // Mark user as authenticated
  }

  res.sendStatus(200); // Acknowledge the webhook event
});

// Route to check if the user is authenticated
app.get('/authstatus/:phoneNumber', (req, res) => {
  const phoneNumber = req.params.phoneNumber;

  // Log the authentication check
  console.log(`Checking authentication status for ${phoneNumber}`);

  const isAuthenticated = !!authenticatedUsers[phoneNumber];
  res.json({ authenticated: isAuthenticated });

  if (isAuthenticated) {
    console.log(`User ${phoneNumber} is authenticated.`);
  } else {
    console.log(`User ${phoneNumber} is not yet authenticated.`);
  }
});

// Route to serve the property form after authentication
app.get('/getpropertyform/:phoneNumber', (req, res) => {
  const phoneNumber = req.params.phoneNumber;

  // Check if the user is authenticated
  if (authenticatedUsers[phoneNumber]) {
    console.log(`Serving form to ${phoneNumber}`);
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Add Property</title>
          <link rel="stylesheet" href="/styles.css">
        </head>
        <body>
          <div class="container">
            <h1>Add Your Property</h1>
            <form action="/submitproperty" method="POST" enctype="multipart/form-data">
              <label for="propertyname">Property Name:</label>
              <input type="text" id="propertyname" name="propertyname" required />
              <label for="address">Address:</label>
              <input type="text" id="address" name="address" required />
              <label for="image">Upload Apartment Image:</label>
              <input type="file" id="image" name="image" accept="image/*" required />
              <label for="units">Number of Units:</label>
              <input type="number" id="units" name="units" required />
              <button type="submit">Submit</button>
            </form>
          </div>
        </body>
      </html>
    `);
  } else {
    // Deny access if the user is not authenticated
    res.status(403).send('Access Denied: You must authenticate first');
  }
});

// Route to handle property form submission
app.post('/submitproperty', upload.single('image'), async (req, res) => {
  const { propertyname, address, units } = req.body;
  const image = req.file?.path; // Path to uploaded file

  const newProperty = new Property({
    propertyName: propertyname,
    address: address,
    image: image,
    units: parseInt(units),
  });

  try {
    await newProperty.save();
    res.send('Property added successfully');
  } catch (error) {
    console.error('Error saving property:', error);
    res.status(500).send('Error saving property');
  }
});

// Function to send WhatsApp message using the provided API structure
async function sendWhatsAppAuthMessage(phoneNumber) {
  try {
    await axios.post(process.env.WHATSAPP_API_URL, {
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

    console.log(`WhatsApp message sent to ${phoneNumber}`);
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
  }
}
// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
