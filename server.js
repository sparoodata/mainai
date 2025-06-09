// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const morgan = require('morgan');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const paymentRoutes = require('./routes/payment');
const { router: whatsappRouter } = require('./routes/webhook');
const rateLimiter = require('./middleware/rateLimiter');
const asyncHandler = require('./middleware/asyncHandler');
const errorHandler = require('./middleware/errorHandler');
const Sentry = require('./services/sentry');

const app = express();
app.use(morgan('dev'));
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.requestHandler());
}
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(cookieParser());
app.use(rateLimiter);

const port = process.env.PORT || 3000;

// Silence Mongoose strictQuery warning for Mongoose >=7
mongoose.set('strictQuery', false);

// Ensure Mongo URI is provided
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI not defined');
  process.exit(1);
}

async function connectWithRetry(retries = 5) {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ MongoDB connected');
  } catch (err) {
    if (retries <= 0) throw err;
    console.error('❌ MongoDB connection failed. Retrying...', err);
    await new Promise(res => setTimeout(res, 5000));
    return connectWithRetry(retries - 1);
  }
}

// Mount payment routes (Webhook raw-body is handled in paymentRoutes)
app.use('/', paymentRoutes);

// JSON & URL-encoded parsers for other routes
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// WhatsApp Webhook routes
app.use('/webhook', whatsappRouter);

// Root route
app.get('/', asyncHandler(async (req, res) => {
  res.send('🟢 Teraa Assistant is running...');
}));

if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

app.use(errorHandler);

async function startServer() {
  await connectWithRetry();
  app.listen(port, () =>
    console.log(`🚀 Server running on http://localhost:${port}`)
  );
}

startServer().catch(err => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});

process.on('unhandledRejection', err => {
  console.error('Unhandled Rejection:', err);
});
