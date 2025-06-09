const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { param, validationResult } = require('express-validator');
const asyncHandler = require('../middleware/asyncHandler');
const User = require('../models/User');
const Payment = require('../models/Payment');
const { sendMessage } = require('../helpers/whatsapp');

const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

// Generate Razorpay Payment Link
router.get('/pay/:phoneNumber',
  param('phoneNumber').notEmpty(),
  asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
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

    await sendMessage(phoneNumber, `💳 *Upgrade to Premium*\nClick below to complete your payment of ₹499/month:`);
    await sendMessage(phoneNumber, paymentLink.short_url);

    return res.status(200).json({ success: true, url: paymentLink.short_url });
  } catch (error) {
    console.error('❌ Error creating payment link:', error);
    return res.status(500).json({ success: false, error: 'Payment link error' });
  }
}));

// Razorpay Webhook Handler (raw-body)
router.post(
  '/razorpay-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature     = req.headers['x-razorpay-signature'];

    try {
      const rawBody = req.body; // Buffer
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      if (signature !== expectedSignature) {
        console.error('❌ Invalid webhook signature');
        return res.status(400).send('Invalid signature');
      }

      const payload = JSON.parse(rawBody.toString());
      const event   = payload.event;
      if (event === 'payment_link.paid') {
        const paymentEntity = payload.payload.payment.entity;
        const phone = paymentEntity.contact;

        const user = await User.findOne({ phoneNumber: phone });
        if (user) {
          const now = new Date();
          const end = new Date(now);
          end.setFullYear(end.getFullYear() + 1);
          user.subscription = 'premium';
          user.subscriptionStart = now;
          user.subscriptionEnd = end;
          await user.save();

          await Payment.create({
            user: user._id,
            razorpayPaymentId: paymentEntity.id,
            amount: paymentEntity.amount,
            currency: paymentEntity.currency,
            status: paymentEntity.status,
            method: paymentEntity.method,
            captured: paymentEntity.captured,
            contact: paymentEntity.contact,
            email: paymentEntity.email,
            fee: paymentEntity.fee,
            tax: paymentEntity.tax,
            description: paymentEntity.description,
            paymentCreatedAt: new Date(paymentEntity.created_at * 1000),
            raw: paymentEntity,
          });

          await sendMessage(
            phone,
            `🎉 *Payment Successful!*\n\nYour subscription is now upgraded to *Premium*.`
          );
        }
      }

      return res.status(200).send('✅ Webhook processed');
    } catch (err) {
      console.error('❌ Webhook processing failed:', err);
      return res.status(500).send('Webhook processing error');
    }
  }
);

module.exports = router;
