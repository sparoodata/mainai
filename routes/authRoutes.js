const express = require('express');
const { body, validationResult } = require('express-validator');
const axios = require('axios');
const generateOTP = require('../utils/generateOTP'); // Adjust path if necessary
const User = require('../models/User');
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const router = express.Router();

// Signup Route
router.post('/signup', [
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

        if (existingUser && existingUser.verified) {
            try {
                const response = await axios.post(WHATSAPP_API_URL, {
                    messaging_product: 'whatsapp',
                    to: phoneNumber,
                    type: 'template',
                    template: { name: 'onboard', language: { code: 'en' } }
                }, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });

                return res.json({ message: 'User already registered and verified', sessionId });
            } catch (error) {
                return res.status(500).json({ error: 'Failed to notify user' });
            }
        } else {
            // New user registration logic
            const otp = generateOTP();
            const newUser = new User({ phoneNumber, otp, otpExpiresAt: Date.now() + 10 * 60 * 1000 });
            await newUser.save();

            const response = await axios.post(WHATSAPP_API_URL, {
                messaging_product: 'whatsapp',
                to: phoneNumber,
                type: 'template',
                template: {
                    name: 'otp',
                    language: { code: 'en' },
                    components: [{ type: 'body', parameters: [{ type: 'text', text: otp }] }]
                }
            }, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });

            res.json({ message: 'OTP sent', sessionId });
        }
    } catch (error) {
        res.status(500).json({ error: 'Signup failed' });
    }
});

// Login Route
router.post('/login', async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = Date.now().toString();

    try {
        const user = await User.findOne({ phoneNumber });
        if (user && user.verified) {
            // Send WhatsApp auth
            const response = await axios.post(WHATSAPP_API_URL, {
                messaging_product: 'whatsapp',
                to: phoneNumber,
                type: 'template',
                template: { name: 'authorize', language: { code: 'en' } }
            }, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });

            res.json({ message: 'Authentication message sent', sessionId });
        } else {
            res.status(404).json({ error: 'User not found or not verified' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Login failed' });
    }
});

// Logout Route
router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ error: 'Failed to logout' });
        res.clearCookie('connect.sid');
        res.json({ message: 'Logged out successfully' });
    });
});

module.exports = router;
