require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');
const app = express();

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

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
    } catch (error) {
        console.error('Error sending WhatsApp message:', error.response ? error.response.data : error.message);
        throw error;
    }
};

// Handle Authentication Request
app.post('/auth', async (req, res) => {
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

// Handle WhatsApp Response (Simplified for this example)
app.post('/auth/verify', (req, res) => {
    const { phoneNumber, response } = req.body;

    if (response === 'Yes') {
        // Authenticate user and redirect to dashboard (simplified)
        res.redirect('/dashboard');
    } else {
        res.redirect('/');
    }
});

// Serve static HTML files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
