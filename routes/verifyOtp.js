const express = require('express');
const router = express.Router();
const axios = require('axios');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

router.post('/', [
    body('phoneNumber').isMobilePhone().withMessage('Invalid phone number'),
    body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
], async (req, res) => {
    const { phoneNumber, otp } = req.body;

    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    try {
        const user = await User.findOne({ phoneNumber });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.otp === otp && user.otpExpiresAt > Date.now()) {
            user.verified = true;
            user.otp = undefined;
            user.otpExpiresAt = undefined;
            await user.save();

            await axios.post(WHATSAPP_API_URL, {
                messaging_product: 'whatsapp',
                to: phoneNumber,
                type: 'template',
                template: { name: 'registration_success', language: { code: 'en' } }
            }, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });

            return res.json({ message: 'User verified successfully' });
        } else {
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Error verifying OTP' });
    }
});

module.exports = router;
