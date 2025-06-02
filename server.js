// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const paymentRoutes = require('./routes/payment');
const { router: whatsappRouter } = require('./routes/webhook');

const app = express();

const port = process.env.PORT || 3000;

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// Mount payment routes (Webhook raw-body is handled in paymentRoutes)
app.use('/', paymentRoutes);

// JSON & URL-encoded parsers for other routes
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// WhatsApp Webhook routes
app.use('/webhook', whatsappRouter);

// Root route
app.get('/', (req, res) => {
  res.send('🟢 Teraa Assistant is running...');
});

app.listen(port, () => console.log(`🚀 Server running on http://localhost:${port}`));
