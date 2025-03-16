const express = require('express');
const axios = require('axios');
const session = require('express-session'); // Assuming express-session is being used for sessions
const router = express.Router();

// WhatsApp API credentials (should ideally come from your environment variables)
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Temporary storage for auth sessions
let sessions = {};

// POST route for sending authentication request
router.post('/', async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = Date.now().toString(); // Generate a unique session ID

    // Track session
    sessions[sessionId] = { phoneNumber, status: 'pending' };

    try {
        const response = await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'template',
            template: {
                name: 'authorize', // Ensure this template exists
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
    } catch (error) {
        console.error('Failed to send authentication message:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'Failed to send authentication message' });
    }
});

module.exports = router;
