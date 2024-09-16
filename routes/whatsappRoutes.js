// routes/whatsappRoutes.js
const express = require('express');
const axios = require('axios');
const sessions = {}; 

const router = express.Router();
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

router.post('/send-auth', async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = Date.now().toString(); 
    sessions[sessionId] = { phoneNumber, status: 'pending' }; 

    try {
        const response = await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'template',
            template: { name: 'authorize', language: { code: 'en' } }
        }, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
        });

        res.json({ message: 'Authentication message sent', sessionId });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send authentication message' });
    }
});

router.get('/auth/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions[sessionId];

    if (session) {
        res.json({ status: session.status });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

module.exports = router;
