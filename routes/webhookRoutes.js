const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const router = express.Router();

// Webhook Verification
router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Unified Webhook Callback
router.post('/webhook', async (req, res) => {
    const { entry } = req.body;

    if (entry && entry.length > 0) {
        const changes = entry[0].changes;
        if (changes && changes.length > 0) {
            const messages = changes[0].value.messages;
            if (messages && messages.length > 0) {
                const message = messages[0];
                const phoneNumber = message.from.replace(/^\+/, '');
                const text = message.text ? message.text.body.trim() : null;

                // Handle OTP Verification
                if (text && /^\d{6}$/.test(text)) {
                    try {
                        const user = await User.findOne({ phoneNumber });

                        if (user && user.otp === text && user.otpExpiresAt > Date.now()) {
                            user.verified = true;
                            user.otp = undefined;
                            user.otpExpiresAt = undefined;
                            await user.save();

                            // Notify user of successful verification
                            await axios.post(WHATSAPP_API_URL, {
                                messaging_product: 'whatsapp',
                                to: phoneNumber,
                                type: 'template',
                                template: { name: 'otp_success', language: { code: 'en' } }
                            }, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
                        }
                    } catch (error) {
                        console.error('OTP verification failed:', error);
                    }
                }
            }
        }
    }

    res.sendStatus(200);
});

module.exports = router;
