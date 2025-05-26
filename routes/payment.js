// payment.js - Razorpay integration
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

const CALLBACK_HOST = process.env.GLITCH_HOST || 'https://yourdomain.com';

// Generate Razorpay Payment Link
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
      notify: {
        sms: false,
        email: false
      },
      callback_url: `${CALLBACK_HOST}/razorpay-webhook`,
      callback_method: 'get'
    });

    await sendMessage(phoneNumber, `💳 *Upgrade to Premium*
Click below to complete your payment of ₹499/month:`);
    await sendMessage(phoneNumber, paymentLink.short_url);

    return res.status(200).json({ success: true, url: paymentLink.short_url });
  } catch (error) {
    console.error('Error creating payment link:', error);
    return res.status(500).json({ success: false, error: 'Payment link error' });
  }
});

// Razorpay Webhook (POST is better but we keep GET for test links)
router.post('/razorpay-webhook', async (req, res) => {
  const crypto = require('crypto');

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'hcbsydhbcsdk';
  const signature = req.headers['x-razorpay-signature'];

  const body = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(body)
    .digest('hex');

  if (signature !== expectedSignature) {
    console.error('❌ Invalid webhook signature');
    return res.status(400).send('Invalid signature');
  }

  const event = req.body.event;

  if (event === 'payment.link.paid') {
    const payment = req.body.payload.payment.entity;
    const phone = `+91${payment.contact}`;
    try {
      const user = await User.findOne({ phoneNumber: phone });
      if (user) {
        user.subscription = 'premium';
        await user.save();
        await sendMessage(phone, `🎉 *Payment Successful!*

Your subscription is now upgraded to *Premium*.
Enjoy unlimited properties, AI help, and rent automation.`);
      }
    } catch (err) {
      console.error('❌ Error updating user:', err);
    }
  }

  res.status(200).send('✅ Webhook received');
});




module.exports = router;
