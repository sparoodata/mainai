const express = require('express');
const axios = require('axios');
const router = express.Router();

// WhatsApp API Configuration
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY; // Store your API key in .env file

// Send WhatsApp Authentication Message
const sendAuthMessage = async (phoneNumber) => {
    try {
        const response = await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'template',
            template: {
                name: 'authorize',
                language: {
                    code: 'en',
                },
            },
        }, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_API_KEY}`,
                'Content-Type': 'application/json',
            },
        });

        return response.data;
      console.log('Webhook received:', response.data);

    } catch (error) {
        console.error('Error sending WhatsApp message:', error);
        throw error;
    }
};

// Handle Authentication Request
router.post('/auth', async (req, res) => {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).send('Phone number is required');
    }

    try {
        await sendAuthMessage(phoneNumber);
        res.status(200).send('Authentication message sent');
    } catch (error) {
        res.status(500).send('Failed to send authentication message');
    }
});


// Handle WhatsApp Response
router.post('/auth/verify', async (req, res) => {
    const { phoneNumber, response } = req.body;

  console.log('Webhook received:', res.body);


    if (res.body === 'Yes') {
        // Authenticate user and redirect to dashboard
        // For example, set session or token here
        res.redirect('/dashboard');
    } else {
        res.redirect('/');
    }
});

module.exports = router;
