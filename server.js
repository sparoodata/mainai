const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const User = require('../models/User'); // Assuming you have a User model
const Tenant = require('../models/Tenant'); // Assuming you have a Tenant model

const app = express();
app.use(bodyParser.json());

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST; // Your Glitch project URL

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

// Function to execute MongoDB query
async function executeMongoQuery(query) {
    try {
        const result = await eval(query);
        return result;
    } catch (error) {
        console.error('Error executing MongoDB query:', error);
        return null;
    }
}

// Endpoint to handle incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
    const message = req.body.messages[0].text.body;
    const from = req.body.messages[0].from;

    // Check if the message is a cURL command
    if (message.startsWith('curl')) {
        // Extract the JSON payload from the cURL command
        const jsonPayload = message.match(/-d\s+'([^']+)'/)[1];
        const payload = JSON.parse(jsonPayload);

        // Extract the query from the payload
        const query = payload.messages.find(msg => msg.role === 'user').content;

        // Execute the MongoDB query
        const queryResult = await executeMongoQuery(query);

        // Send the result back to the user via WhatsApp
        const responseMessage = queryResult ? JSON.stringify(queryResult) : 'Error executing query';
        await axios.post(WHATSAPP_API_URL, {
            messaging_product: "whatsapp",
            to: from,
            text: { body: responseMessage }
        }, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
    }

    res.sendStatus(200);
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});