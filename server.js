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


app.get("/addtenant/:phone_no", async (req, res) => {
  const phoneNo = req.params.phone_no;
  
  try {
    // Step 1: Trigger WhatsApp authorization message
    const whatsappResponse = await axios.post("https://api.whatsapp.com/send", {
      to: phoneNo,
      template: {
        name: "authorize",
        language: {
          code: "en"
        },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: "Please authorize by replying 'Yes' to access the tenant form."
              }
            ]
          }
        ]
      }
    });

    // Check if the request was successful (this may depend on WhatsApp API response)
    if (whatsappResponse.status === 200) {
      // Assuming the response can be tracked, wait for the user response

      // Step 2: Wait for the response ('Yes' or 'No') through a webhook or polling mechanism
      const userResponse = await waitForUserResponse(phoneNo); // Implement logic to wait for WhatsApp response

      if (userResponse === "Yes") {
        // Step 3: Render the HTML form to add tenant
        res.sendFile(__dirname + "/public/addtenant.html");
      } else {
        res.status(401).send("Authorization failed. You cannot access this form.");
      }
    } else {
      res.status(500).send("Failed to send WhatsApp authorization.");
    }
  } catch (error) {
    console.error("Error in sending WhatsApp message: ", error);
    res.status(500).send("Server error. Please try again.");
  }
});

// Function to handle response from WhatsApp (stubbed for illustration)
async function waitForUserResponse(phoneNo) {
  // This function should wait for the response from the WhatsApp webhook or any other mechanism you're using
  // For now, let's assume the response is handled elsewhere and we get it as a 'Yes' or 'No' string.
  // You can implement it with a proper webhook listener or through API callbacks.
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve("Yes"); // Simulating a 'Yes' response
    }, 3000);
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
