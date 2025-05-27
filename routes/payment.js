// payment.js
const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const User = require('../models/User');
const { sendMessage } = require('../helpers/whatsapp');

const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

// --- 1. Razorpay Payment Link Generation ---
router.get('/pay/:phoneNumber', async (req, res) => {
  const phoneNumber = decodeURIComponent(req.params.phoneNumber);
  try {
    const paymentLink = await razorpay.paymentLink.create({
      amount: 49900, // Rs. 499 in paise
      currency: 'INR',
      accept_partial: false,
      description: 'Teraa Assistant Premium Plan (Monthly)',
      customer: {
        name: phoneNumber,
        contact: phoneNumber.replace('+91', ''),
        email: `${phoneNumber.replace('+', '')}@teraa.ai`
      },
      notify: { sms: false, email: false },
      reminder_enable: true
    });

    await sendMessage(phoneNumber,
      `💳 *Upgrade to Premium*\nClick below to complete your payment of ₹499/month:`);
    await sendMessage(phoneNumber, paymentLink.short_url);

    return res.status(200).json({ success: true, url: paymentLink.short_url });
  } catch (error) {
    console.error('❌ Error creating payment link:', error);
    return res.status(500).json({ success: false, error: 'Payment link error' });
  }
});

// --- 2. Razorpay Webhook Handler ---
// This route MUST use express.raw to get Buffer, not parsed object!
router.post('/razorpay-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body; // Buffer

  try {
    // 1. Validate signature
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');
    if (signature !== expectedSignature) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).send('Invalid signature');
    }

    // 2. Parse payload
    const payload = JSON.parse(rawBody.toString());
    const event = payload.event;

    // 3. Handle payment success event
    if (event === 'payment.link.paid') {
      const phone = `+91${payload.payload.payment.entity.contact}`;
      const user = await User.findOne({ phoneNumber: phone });
      if (user) {
        user.subscription = 'premium';
        await user.save();
        await sendMessage(phone,
          `🎉 *Payment Successful!*\n\nYour subscription is now upgraded to *Premium*. Enjoy unlimited units, AI reports, and automated reminders!`);
      }
    }

    return res.status(200).send('✅ Webhook processed');
  } catch (err) {
    console.error('❌ Webhook processing failed:', err);
    return res.status(500).send('Webhook processing error');
  }
});

module.exports = router;
