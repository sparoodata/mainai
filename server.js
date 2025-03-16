// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');

// Database connection
const connectDB = require('./config/db');

// Route modules
const webhookRoutes = require('./routes/webhook');
const imageUploadRoutes = require('./routes/imageUpload');
const chatRoutes = require('./routes/chat');

const app = express();
const port = process.env.PORT || 3000;

// 1) Connect to MongoDB
connectDB();

// 2) Session setup
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions',
    ttl: 3600,
  }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 3600000, // 1 hour
  },
}));

// 3) Basic Express config
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 4) Use your routes
app.use('/webhook', webhookRoutes);
app.use('/upload-image', imageUploadRoutes);
app.use('/chat', chatRoutes);

// 5) Start server
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
