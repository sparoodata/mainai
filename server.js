// server.js

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const paymentRoutes = require('./routes/payment');
const { router: whatsappRouter } = require('./routes/webhook');

const app = express();
const port = process.env.PORT || 3000;

// 1. Connect to MongoDB...
// (omitted for brevity)

// 2. Raw‐body parser for the Razorpay webhook **before** any JSON parser
app.post(
  '/razorpay-webhook',
  express.raw({ type: 'application/json' }),
  paymentRoutes   // mount the paymentRoutes handler _only_ for this route
);

// 3. Now apply your JSON & urlencoded parsers
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 4. Other routes
app.use('/webhook', whatsappRouter);
app.use('/', whatsappRouter); // or however you're mounting your other routes

app.get('/', (req, res) => res.send('🟢 Teraa Assistant is running...'));
app.listen(port, () => console.log(`🚀 Server running on http://localhost:${port}`));
