const express = require('express');
const axios = require('axios'); // Required for sending WhatsApp messages
const User = require('../models/User'); // User model for checking database
const router = express.Router();

// WhatsApp API configurations
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL; 
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Sessions to track OTP validation
let sessions = {};

// POST route for user login
router.post('/', async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = Date.now().toString();

    try {
        // Check if the user exists and is verified
        const user = await User.findOne({ phoneNumber });

        if (!user) {
            return res.status(404).json({ error: 'Phone number not registered. Please sign up.' });
        }

        if (user && user.verified) {
            // Store session data with a timestamp for expiration
            sessions[sessionId] = { phoneNumber, status: 'pending', createdAt: Date.now() };

            // Send WhatsApp authentication message
            const response = await axios.post(WHATSAPP_API_URL, {
                messaging_product: 'whatsapp',
                to: phoneNumber,
                type: 'template',
                template: {
                    name: 'authorize',
                    language: { code: 'en' }
                }
            }, {
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`
                }
            });

            // Check for WhatsApp API errors
            if (response.data.errors) {
                return res.status(500).json({ error: 'Failed to send WhatsApp message. Try again later.' });
            }

            res.json({ status: 'pending', message: 'WhatsApp message sent for authentication.' });
        }
    } catch (error) {
        console.error('Error in WhatsApp authentication:', error);
        res.status(500).json({ error: 'Server error. Please try again later.' });
    }
});

// Additional route for OTP validation (Optional)
router.post('/validate-otp', (req, res) => {
    const { sessionId, otp } = req.body;
    const session = sessions[sessionId];

    if (!session) {
        return res.status(400).json({ error: 'Invalid session. Please try again.' });
    }

    // Check if the OTP is expired (10-minute validity)
    if ((Date.now() - session.createdAt) > 10 * 60 * 1000) {
        return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    }

    // Verify the OTP (Assuming you have a verifyOTP function)
    if (verifyOTP(session.phoneNumber, otp)) {
        session.status = 'verified';
        return res.json({ message: 'OTP verified successfully.' });
    } else {
        return res.status(400).json({ error: 'Invalid OTP. Please try again.' });
    }
});

module.exports = router;
