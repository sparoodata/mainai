require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');

const { router } = require('./routes/webhook'); // This contains only registration + menu logic
const paymentRoutes = require('./routes/payment');


const app = express();
const port = process.env.PORT || 3000;

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
// Webhook must come before bodyParser.json()
app.post('/razorpay-webhook', express.raw({ type: 'application/json' }));


// WhatsApp Webhook
app.use('/webhook', router);
app.use('/', paymentRoutes);

// Root route
app.get('/', (req, res) => {
  res.send('🟢 Teraa Assistant is running...');
});

app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
});
