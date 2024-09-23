const express = require('express');
const router = express.Router();
const axios = require('axios');
const Tenant = require('../models/Tenant');

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === process.env.VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

router.post('/', async (req, res) => {
    const { entry } = req.body;
    if (entry && entry.length > 0) {
        const messages = entry[0].changes[0].value.messages;
        if (messages && messages.length > 0) {
            const message = messages[0];
            const phoneNumber = message.from.replace(/^\+/, '');

            if (message.text && /^\d{6}$/.test(message.text.body)) {
                // OTP Verification logic here
            } else if (message.button && message.button.payload === 'Rent paid') {
                const tenantId = message.button.payload.split('-')[1];
                const tenant = await Tenant.findOne({ tenant_id: tenantId });

                if (tenant) {
                    tenant.status = 'PAID';
                    await tenant.save();
                }
            }
        }
    }

    res.sendStatus(200);
});

module.exports = router;
