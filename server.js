require('dotenv').config();
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

// In-memory storage for session management
const sessions = {}; // { phoneNumber: { status: 'pending', timeout: <timestamp> } }

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
        sessions[phoneNumber] = {
            status: 'pending',
            timeout: Date.now() + 30000 // 30 seconds
        };
        res.status(200).send('Authentication message sent');
    } catch (error) {
        res.status(500).send('Failed to send authentication message');
    }
});

// Handle WhatsApp Webhook
app.post('/webhook', (req, res) => {
    const { entry } = req.body;

    if (entry && entry.length > 0) {
        const changes = entry[0].changes;
        if (changes && changes.length > 0) {
            const messages = changes[0].value.messages;
            if (messages && messages.length > 0) {
                const message = messages[0];
                const phoneNumber = message.from;
                const payload = message.button ? message.button.payload : null;

                if (payload === 'Yes') {
                    if (sessions[phoneNumber] && sessions[phoneNumber].status === 'pending') {
                        sessions[phoneNumber].status = 'authenticated';
                    }
                }
            }
        }
    }

    res.sendStatus(200); // Respond to the webhook
});

app.post('/webhook', (req, res) => {
    const { entry } = req.body;

    if (entry && entry.length > 0) {
        const changes = entry[0].changes;
        if (changes && changes.length > 0) {
            const messages = changes[0].value.messages;
            if (messages && messages.length > 0) {
                const message = messages[0];
                const phoneNumber = message.from;
                const payload = message.button ? message.button.payload : null;

                if (payload === 'Yes') {
                    if (sessions[phoneNumber] && sessions[phoneNumber].status === 'pending') {
                        sessions[phoneNumber].status = 'authenticated';
                    }
                }
            }
        }
    }

    res.sendStatus(200); // Respond to the webhook
});



// Check authentication status
app.post('/auth/status', (req, res) => {
    const { phoneNumber } = req.body;

    if (sessions[phoneNumber]) {
        const session = sessions[phoneNumber];
        if (session.status === 'authenticated') {
            res.status(200).send('authenticated');
        } else if (Date.now() > session.timeout) {
            delete sessions[phoneNumber];
            res.status(408).send('timeout');
        } else {
            res.status(202).send('pending');
        }
    } else {
        res.status(404).send('not found');
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
