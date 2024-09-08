const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

const sessions = {}; // Store session data here

app.use(bodyParser.json());
app.use(express.static('public'));

app.post('/auth', async (req, res) => {
    const { phoneNumber } = req.body;
    const sessionId = phoneNumber; // Use phone number as session ID

    // Create a new session with 'pending' status
    sessions[sessionId] = { status: 'pending' };

    try {
        // Send WhatsApp authentication request
        await axios.post('https://graph.facebook.com/v20.0/110765315459068/messages', {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'template',
            template: {
                name: 'authorize',
                language: { code: 'en' }
            }
        }, {
            headers: {
                'Authorization': 'Bearer <secret key>',
                'Content-Type': 'application/json'
            }
        });

        res.sendStatus(200);
    } catch (error) {
        console.error('Failed to send authentication message:', error.response ? error.response.data : error.message);
        res.status(500).send('Failed to send authentication message');
    }
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

                if (sessions[phoneNumber]) {
                    if (payload === 'Yes') {
                        sessions[phoneNumber].status = 'authenticated';
                    } else if (payload === 'No') {
                        sessions[phoneNumber].status = 'denied';
                    }
                }
            }
        }
    }

    res.sendStatus(200); // Respond to the webhook
});

app.post('/auth/status', (req, res) => {
    const { phoneNumber } = req.body;

    if (sessions[phoneNumber]) {
        const status = sessions[phoneNumber].status;
        if (status === 'authenticated') {
            res.send('authenticated');
        } else if (status === 'denied') {
            res.send('denied');
        } else {
            res.send('pending');
        }
    } else {
        res.send('not_found');
    }
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
