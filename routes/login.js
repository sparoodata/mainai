const express = require('express');
const axios = require('axios'); // Assuming you need axios for sending WhatsApp messages
const User = require('../models/User'); // Assuming you have a User model
const router = express.Router();

// Define WhatsApp API configurations
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL; // Get this from your environment variables
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN; // Get this from your environment variables

// POST route for user login
router.post('/', async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = Date.now().toString();

    try {
        // Check if the user exists and is verified
        const user = await User.findOne({ phoneNumber });

        if (!user) {
            // Phone number not registered
            return res.status(404).json({ error: 'Phone number not registered. Please sign up.' });
        }

        if (user && user.verified) {
            // User is verified, send WhatsApp authentication message
            sessions[sessionId] = { phoneNumber, status: 'pending' };

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
                    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('Authentication message sent successfully:', response.data);
            res.json({ message: 'Authentication message sent', sessionId });
        } else {
            res.status(403).json({ error: 'User not verified. Please verify your account.' });
        }
    } catch (error) {
        console.error('Login failed:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'Login failed' });
    }
});

module.exports = router;
