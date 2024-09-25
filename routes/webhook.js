const express = require('express');
const axios = require('axios');
const User = require('../models/User'); // Assuming you have a User model
const Tenant = require('../models/Tenant'); // Assuming you have a Tenant model
const router = express.Router();

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Webhook verification for WhatsApp API
router.get('/', (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // Your WhatsApp verification token

    // Parse query parameters
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Check if mode and token are present
    if (mode && token) {
        // Verify the token matches
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('Webhook verified successfully');
            res.status(200).send(challenge);
        } else {
            // Respond with '403 Forbidden' if token is invalid
            console.error('Webhook verification failed');
            res.sendStatus(403);
        }
    }
});

// Webhook event handling
router.post('/', async (req, res) => {
    const body = req.body;

    console.log('Webhook received:', JSON.stringify(body, null, 2));

    // Check if this is an event from WhatsApp Business API
    if (body.object === 'whatsapp_business_account') {
        const entry = body.entry[0];
        const changes = entry.changes[0];

        if (changes.value.messages) {
            const message = changes.value.messages[0];
            const phoneNumber = message.from.replace(/^\+/, ''); // Phone number of the sender
            const text = message.text ? message.text.body.trim() : null; // Message body
            const payload = message.button ? message.button.payload : null; // Button payload if it exists
            const text1 = message.button ? message.button.text : null; // Button text if exists

            // Log the received message
            console.log(`Received message from ${phoneNumber}: ${text || payload || text1}`);

            // Handle OTP Verification
            if (text && /^\d{6}$/.test(text)) { // If the message is a 6-digit OTP
                try {
                    const user = await User.findOne({ phoneNumber });

                    if (user && user.otp === text && user.otpExpiresAt > Date.now()) {
                        user.verified = true;
                        user.otp = undefined;
                        user.otpExpiresAt = undefined;
                        await user.save();

                        console.log('User verified successfully:', phoneNumber);

                        // Send confirmation message
                        try {
                            await axios.post(WHATSAPP_API_URL, {
                                messaging_product: 'whatsapp',
                                to: phoneNumber,
                                type: 'template',
                                template: {
                                    name: 'otp_success', // Template for OTP success
                                    language: { code: 'en' }
                                }
                            }, {
                                headers: {
                                    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                    'Content-Type': 'application/json'
                                }
                            });
                        } catch (error) {
                            console.error('Error sending OTP success message:', error.response ? error.response.data : error);
                        }
                    } else {
                        console.log('Invalid or expired OTP for:', phoneNumber);

                        // Send OTP failure message
                        try {
                            await axios.post(WHATSAPP_API_URL, {
                                messaging_product: 'whatsapp',
                                to: phoneNumber,
                                type: 'template',
                                template: {
                                    name: 'otp_failure', // Template for OTP failure
                                    language: { code: 'en' }
                                }
                            }, {
                                headers: {
                                    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                    'Content-Type': 'application/json'
                                }
                            });
                        } catch (error) {
                            console.error('Error sending OTP failure message:', error.response ? error.response.data : error);
                        }
                    }
                } catch (error) {
                    console.error('Error verifying OTP:', error.response ? error.response.data : error);
                }
            }

            // Handle authentication via button payloads
            if (payload) {
                if (payload === 'Yes') {
                    console.log('Authentication confirmed for:', phoneNumber);

                    try {
                        // Send success message
                        await axios.post(WHATSAPP_API_URL, {
                            messaging_product: 'whatsapp',
                            to: phoneNumber,
                            type: 'template',
                            template: {
                                name: 'auth_success', // Template for successful authentication
                                language: { code: 'en' }
                            }
                        }, {
                            headers: {
                                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                'Content-Type': 'application/json'
                            }
                        });

                        // Update session status to authenticated (optional)
                        // Example: if you are tracking sessions
                        // sessions[sessionId].status = 'authenticated';
                        console.log(`Authentication successful for ${phoneNumber}`);
                    } catch (error) {
                        console.error('Error sending auth success message:', error.response ? error.response.data : error);
                    }
                } else if (payload === 'No') {
                    console.log('Authentication denied for:', phoneNumber);

                    try {
                        // Send denial message
                        await axios.post(WHATSAPP_API_URL, {
                            messaging_product: 'whatsapp',
                            to: phoneNumber,
                            type: 'template',
                            template: {
                                name: 'auth_denied', // Template for denied authentication
                                language: { code: 'en' }
                            }
                        }, {
                            headers: {
                                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                'Content-Type': 'application/json'
                            }
                        });

                        console.log(`Authentication denied for ${phoneNumber}`);
                    } catch (error) {
                        console.error('Error sending auth denied message:', error.response ? error.response.data : error);
                    }
                }
            }

            // Handle rent payment confirmation
            if (text1 === 'Rent paid') {
                const tenantId = payload.split('-')[1].split(' ')[0]; // Extract tenant ID
                console.log('Processing rent payment for tenant ID:', tenantId);

                try {
                    const tenant = await Tenant.findOne({ tenant_id: tenantId });

                    if (tenant) {
                        tenant.status = 'PAID';
                        await tenant.save();

                        console.log('Tenant rent status updated to PAID:', tenantId);

                        // Send confirmation message
                        await axios.post(WHATSAPP_API_URL, {
                            messaging_product: 'whatsapp',
                            to: phoneNumber,
                            type: 'text',
                            text: {
                                body: `Tenant ID: *${tenantId}* has been marked as PAID. 👍`
                            }
                        }, {
                            headers: {
                                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                'Content-Type': 'application/json'
                            }
                        });
                    } else {
                        console.log('Tenant not found for tenant ID:', tenantId);
                    }
                } catch (error) {
                    console.error('Error updating rent status:', error.response ? error.response.data : error);
                }
            }
        }
    } else {
        // Return 404 for non-WhatsApp events
        res.sendStatus(404);
    }

    // Respond to WhatsApp API with success
    res.sendStatus(200);
});

module.exports = router;
