const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');
const morgan = require('morgan');
const helmet = require('helmet');
const dotenv = require('dotenv');
const fs = require('fs');
const multer = require('multer');

// Load environment variables
dotenv.config();

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Initialize Express app
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev')); // Logging
app.use(helmet({ contentSecurityPolicy: false })); // Security headers

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'rental-bot-secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions'
  }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  }
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  console.log('MongoDB connected');
  
  // Initialize MongoDB memory system
  const mongoMemory = require('./utils/mongoMemory');
  mongoMemory.initializeMongoMemory()
    .then(success => {
      if (success) {
        console.log('MongoDB memory system initialized successfully');
      } else {
        console.error('Failed to initialize MongoDB memory system');
      }
    })
    .catch(err => {
      console.error('Error initializing MongoDB memory system:', err);
    });
})
.catch(err => console.error('MongoDB connection error:', err));

// Routes
app.use('/api/webhook', require('./routes/webhook'));
app.use('/api', require('./routes/api'));
app.use('/whatsapp', require('./routes/whatsapp'));

// Serve the main HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access the chatbot at http://localhost:${PORT}`);
});
