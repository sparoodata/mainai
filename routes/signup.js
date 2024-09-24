const express = require('express');
const { body, validationResult } = require('express-validator');
const axios = require('axios');
const generateOTP = require('../utils/generateOTP');
const User = require('../models/User');
const rateLimit = require('express-rate-limit');

// WhatsApp API Credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const router = express.Router();

// Rate Limiter for Signup
const signupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: 'Too many signup attempts from this IP, please try again later.'
});

// Signup Route
router.post('/', signupLimiter, [
    body('phoneNumber').isMobilePhone().withMessage('Invalid phone number')
], async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = Date.now().toString(); // Generate a unique session ID

    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    try {
        // Check if the user already exists
        const existingUser = await User.findOne({ phoneNumber });

        if (existingUser) {
            if (existingUser.verified) {
                // User already verified, send a message
                try {
                    const response = await axios.post(WHATSAPP_API_URL, {
                        messaging_product: 'whatsapp',
                        to: phoneNumber,
                        type: 'template',
                        template: {
                            name: 'userexists',
                            language: { code: 'en' }
                        }
                    }, {
                        headers: {
                            'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    console.log('User already registered and verified, message sent:', response.data);
                    return res.json({ message: 'User already registered and verified', sessionId });
                } catch (error) {
                    console.error('Failed to send message:', error.response ? error.response.data : error);
                    return res.status(500).json({ error: 'Failed to notify user' });
                }
            } else {
                // User exists but not verified, resend OTP
                const otp = generateOTP();
                existingUser.otp = otp;
                existingUser.otpExpiresAt = Date.now() + 10 * 60 * 1000; // OTP valid for 10 minutes
                await existingUser.save();

                // Send OTP via WhatsApp
                const response = await axios.post(WHATSAPP_API_URL, {
                    messaging_product: 'whatsapp',
                    to: phoneNumber,
                    type: 'template',
                    template: {
                        name: 'onboard_otp',
                        language: { code: 'en' },
                        components: [
                            {
                                type: 'body',
                                parameters: [
                                    { type: 'text', text: otp }
                                ]
                            }
                        ]
                    }
                }, {
                    headers: {
                        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });

                console.log('OTP resent successfully:', response.data);
                return res.json({ message: 'OTP resent', sessionId });
            }
        }

        // If user doesn't exist, create a new entry and send OTP via WhatsApp
        const otp = generateOTP();
        const newUser = new User({
            phoneNumber,
            otp,
            otpExpiresAt: Date.now() + 10 * 60 * 1000 // OTP valid for 10 minutes
        });
        await newUser.save(); // Save the new user to MongoDB

        // Send OTP to WhatsApp for new user registration
        const response = await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'template',
            template: {
                name: 'onboard_otp',
                language: { code: 'en' },
                components: [
                    {
                        type: 'body',
                        parameters: [
                            { type: 'text', text: otp }
                        ]
                    }
                ]
            }
        }, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('OTP sent successfully:', response.data);
        res.json({ message: 'OTP sent', sessionId });

    } catch (error) {
        console.error('Signup failed:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'Signup failed' });
    }
});

module.exports = router;
