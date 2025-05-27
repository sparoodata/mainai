const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const User = require('../models/User');
const { sendMessage } = require('../helpers/whatsapp');

const router = express.Router();

// Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

// Payment link creation
router.get('/pay/:phoneNumber', async (req, res) => {
  const phoneNumber = decodeURIComponent(req.params.phoneNumber);

  try {
    const paymentLink = await razorpay.paymentLink.create({
      amount: 49900,
      currency: 'INR',
      accept_partial: false,
      description: 'Teraa Assistant Premium Plan (Monthly)',
      customer: {
        name: phoneNumber,
        contact: phoneNumber.replace('+91', ''),
        email: `${phoneNumber.replace('+', '')}@teraa.ai`,
      },
      notify: {
        sms: false,
        email: false,
      },
      reminder_enable: true
    });

    await sendMessage(phoneNumber, `💳 *Upgrade to Premium*\nClick below to complete your payment of ₹499/month:`);
    await sendMessage(phoneNumber, paymentLink.short_url);

    return res.status(200).json({ success: true, url: paymentLink.short_url });
  } catch (error) {
    console.error('❌ Error creating payment link:', error);
    return res.status(500).json({ success: false, error: 'Payment link error' });
  }
});

// Razorpay webhook (POST)
router.post('/razorpay-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(req.body) // ⚠️ Must be raw Buffer!
      .digest('hex');

    if (signature !== expected) {
      console.error('❌ Invalid Razorpay webhook signature');
      return res.status(400).send('Invalid signature');
    }

    const payload = JSON.parse(req.body.toString());

    if (payload.event === 'payment.link.paid') {
      const phone = `+91${payload.payload.payment.entity.contact}`;
      const user = await User.findOne({ phoneNumber: phone });
      if (user) {
        user.subscription = 'premium';
        await user.save();

        await sendMessage(phone, `🎉 *Payment Successful!*\n\nYour subscription has been upgraded to *Premium*. Enjoy all advanced features including AI help, reminders, and unlimited units.`);
      }
    }

    return res.status(200).send('✅ Webhook processed');
  } catch (err) {
    console.error('❌ Webhook processing failed:', err);
    return res.status(500).send('Error processing webhook');
  }
});

module.exports = router;
