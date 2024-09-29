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

// Property schema and model for MongoDB
const propertySchema = new mongoose.Schema({
  propertyName: String,
  address: String,
  image: String, // Store image URL or base64 string for simplicity
  units: Number
});

const Property = mongoose.model('Property', propertySchema);

app.get('/addproperty/:phoneNumber', async (req, res) => {
  const phoneNumber = req.params.phoneNumber;

  // Display waiting for authentication message
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Waiting for Authentication</title>
        <style>
          body, html {
            height: 100%;
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            font-family: Arial, sans-serif;
            background-color: #f0f0f0;
          }
          .container {
            text-align: center;
            background-color: white;
            padding: 50px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            border-radius: 8px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Waiting for WhatsApp Authentication</h1>
          <p>Please respond to the WhatsApp message we sent to proceed.</p>
        </div>
      </body>
    </html>
  `);

  try {
    const response = await sendWhatsAppAuthMessage(phoneNumber);

    // Simulate waiting for user response
    const userResponse = await waitForUserResponse(phoneNumber);

    if (userResponse === 'Yes') {
      // If authorized, load form
      res.send(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Add Property</title>
            <style>
              body, html {
                height: 100%;
                margin: 0;
                display: flex;
                justify-content: center;
                align-items: center;
                font-family: Arial, sans-serif;
                background-color: #f0f0f0;
              }
              .container {
                text-align: center;
                background-color: white;
                padding: 50px;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
                border-radius: 8px;
              }
              form {
                display: flex;
                flex-direction: column;
                align-items: center;
              }
              label {
                font-weight: bold;
                margin-top: 10px;
                display: block;
              }
              input, button {
                margin-top: 10px;
                padding: 8px;
                width: 100%;
                max-width: 300px;
                box-sizing: border-box;
              }
              button {
                background-color: #4CAF50;
                color: white;
                border: none;
                cursor: pointer;
              }
            </style>
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
      res.status(401).send('Unauthorized');
    }
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    res.status(500).send('Something went wrong');
  }
});

app.post('/submitproperty', async (req, res) => {
  const { propertyname, address, units } = req.body;
  const image = req.files?.image?.path; // Assuming the file is uploaded

  const newProperty = new Property({
    propertyName: propertyname,
    address: address,
    image: image, // Save image path or base64 string here
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

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
