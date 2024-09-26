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
// Webhook event handling
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

            // Handle "help" message (case-insensitive)
            if (text && text.toLowerCase() === 'help') {
                try {
                    const menuMessage = `
                        *Menu Options*:
                        1. Account Info
                        2. Manage
                        3. Transactions
                        4. Apartment Info
                        5. Unit Info
                        6. Tenants Info
                    `;

                    // Send the menu message
                    await axios.post(WHATSAPP_API_URL, {
                        messaging_product: 'whatsapp',
                        to: phoneNumber,
                        type: 'text',
                        text: {
                            body: menuMessage
                        }
                    }, {
                        headers: {
                            'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    console.log('Menu sent to:', phoneNumber);
                } catch (error) {
                    console.error('Error sending menu:', error.response ? error.response.data : error);
                }
            }

            // Handle Account Info (Option 1)
            if (text === '1') {
                try {
                    // Fetch user registration details based on phoneNumber
                    const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });

                    if (user) {
                        // Send the user registration details
                        const accountInfoMessage = `
                            *Account Info*:
                            - Phone Number: ${user.phoneNumber}
                            - Verified: ${user.verified ? 'Yes' : 'No'}
                        `;

                        await axios.post(WHATSAPP_API_URL, {
                            messaging_product: 'whatsapp',
                            to: phoneNumber,
                            type: 'text',
                            text: {
                                body: accountInfoMessage
                            }
                        }, {
                            headers: {
                                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                'Content-Type': 'application/json'
                            }
                        });

                        console.log('Account info sent to:', phoneNumber);
                    } else {
                        // If user is not found, send an error message
                        await axios.post(WHATSAPP_API_URL, {
                            messaging_product: 'whatsapp',
                            to: phoneNumber,
                            type: 'text',
                            text: {
                                body: 'No account information found for this number.'
                            }
                        }, {
                            headers: {
                                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                'Content-Type': 'application/json'
                            }
                        });

                        console.log('No account information found for:', phoneNumber);
                    }
                } catch (error) {
                    console.error('Error fetching account info:', error.response ? error.response.data : error);
                }
            }

            // Existing OTP verification and other logic can remain unchanged
            if (text && /^\d{6}$/.test(text)) {
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
                                    name: 'otp_success',
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
                                    name: 'otp_failure',
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

            // Handle authentication via button payloads (existing logic)
            if (payload) {
                if (payload === 'Yes') {
                    console.log('Authentication confirmed for:', phoneNumber);

                    try {
                        await axios.post(WHATSAPP_API_URL, {
                            messaging_product: 'whatsapp',
                            to: phoneNumber,
                            type: 'template',
                            template: {
                                name: 'auth_success',
                                language: { code: 'en' }
                            }
                        }, {
                            headers: {
                                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                'Content-Type': 'application/json'
                            }
                        });

                        console.log(`Authentication successful for ${phoneNumber}`);
                    } catch (error) {
                        console.error('Error sending auth success message:', error.response ? error.response.data : error);
                    }
                } else if (payload === 'No') {
                    console.log('Authentication denied for:', phoneNumber);

                    try {
                        await axios.post(WHATSAPP_API_URL, {
                            messaging_product: 'whatsapp',
                            to: phoneNumber,
                            type: 'template',
                            template: {
                                name: 'auth_denied',
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

            // Handle rent payment confirmation (existing logic)
            if (text1 === 'Rent paid') {
                const tenantId = payload.split('-')[1].split(' ')[0];
                console.log('Processing rent payment for tenant ID:', tenantId);

                try {
                    const tenant = await Tenant.findOne({ tenant_id: tenantId });

                    if (tenant) {
                        tenant.status = 'PAID';
                        await tenant.save();

                        console.log('Tenant rent status updated to PAID:', tenantId);

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
        res.sendStatus(404);
    }

    // Respond to WhatsApp API with success
    res.sendStatus(200);
});

module.exports = router;
