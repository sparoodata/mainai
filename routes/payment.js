// ✅ FIXED payment.js - Razorpay integration using GET callback (with correct signature validation)
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

// Create Razorpay Payment Link
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
        email: `${phoneNumber.replace('+', '')}@teraa.ai`
      },
      notify: {
        sms: false,
        email: false
      },
      callback_url: `${CALLBACK_HOST}/razorpay-webhook`,
      callback_method: 'get'
    });

    await sendMessage(phoneNumber, `💳 *Upgrade to Premium*\nClick below to complete your payment of \u20B9499/month:`);
    await sendMessage(phoneNumber, paymentLink.short_url);

    res.status(200).json({ success: true, url: paymentLink.short_url });
  } catch (error) {
    console.error('Error creating payment link:', error);
    res.status(500).json({ success: false, error: 'Payment link error' });
  }
});

// Razorpay GET Callback - Signature validation (FOR CALLBACK, not webhook)
router.get('/razorpay-webhook', async (req, res) => {
  const {
    razorpay_payment_id,
    razorpay_payment_link_id,
    razorpay_payment_link_reference_id = '',
    razorpay_payment_link_status,
    razorpay_signature
  } = req.query;

  const payload = `${razorpay_payment_link_id}|${razorpay_payment_link_reference_id}|${razorpay_payment_link_status}`;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_SECRET)
    .update(payload)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    console.error('❌ Invalid Razorpay signature');
    return res.status(400).send('Invalid signature');
  }

  if (razorpay_payment_link_status === 'paid') {
    try {
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      const phone = `+91${payment.contact}`;
      const user = await User.findOne({ phoneNumber: phone });

      if (user) {
        user.subscription = 'premium';
        await user.save();

        await sendMessage(phone, `🎉 *Payment Successful!*\n\nYour subscription is now upgraded to *Premium*.\nEnjoy unlimited properties, AI help, and smart rent automation!`);
      }
    } catch (err) {
      console.error('❌ Error during payment processing:', err);
    }
  }

  res.status(200).send('✅ Payment processed successfully.');
});

module.exports = router;
