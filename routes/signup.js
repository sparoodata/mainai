const express = require('express');
const router = express.Router();
const axios = require('axios');
const { body, validationResult } = require('express-validator');
const generateOTP = require('../utils/generateOTP');
const User = require('../models/User');

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Signup Route
router.post('/', [
    body('phoneNumber').isMobilePhone().withMessage('Invalid phone number')
], async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = Date.now().toString();

    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    try {
        const existingUser = await User.findOne({ phoneNumber });

        if (existingUser) {
            if (existingUser.verified) {
                // User already registered and verified
                const response = await axios.post(WHATSAPP_API_URL, {
                    messaging_product: 'whatsapp',
                    to: phoneNumber,
                    type: 'template',
                    template: { name: 'userexists', language: { code: 'en' } }
                }, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });

                return res.json({ message: 'User already registered and verified', sessionId });
            } else {
                // Resend OTP
                const otp = generateOTP();
                existingUser.otp = otp;
                existingUser.otpExpiresAt = Date.now() + 10 * 60 * 1000;
                await existingUser.save();

                await axios.post(WHATSAPP_API_URL, {
                    messaging_product: 'whatsapp',
                    to: phoneNumber,
                    type: 'template',
                    template: { name: 'onboard_otp', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: otp }] }] }
                }, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });

                return res.json({ message: 'OTP resent', sessionId });
            }
        }

        // Create new user and send OTP
        const otp = generateOTP();
        const newUser = new User({ phoneNumber, otp, otpExpiresAt: Date.now() + 10 * 60 * 1000 });
        await newUser.save();

        await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'template',
            template: { name: 'onboard_otp', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: otp }] }] }
        }, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });

        res.json({ message: 'OTP sent', sessionId });
    } catch (error) {
        res.status(500).json({ error: 'Signup failed' });
    }
});

module.exports = router;
