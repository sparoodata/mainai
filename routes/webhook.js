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
const sessions = {}; // This will track the state of each user's session

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

            // Initialize session if not existing
            if (!sessions[phoneNumber]) {
                sessions[phoneNumber] = { expectingMenuSelection: false };
            }

            // Log the received message
            console.log(`Received message from ${phoneNumber}: ${text || payload || text1}`);

            // Handle "help" message (case-insensitive)
            if (text && text.toLowerCase() === 'help') {
                try {
                    // Set session state to expect menu selection
                    sessions[phoneNumber].expectingMenuSelection = true;

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

            // Handle user response to menu (e.g., Account Info, Option 1)
            else if (text === '1' && sessions[phoneNumber].expectingMenuSelection) {
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

                    // Reset session state after valid selection
                    sessions[phoneNumber].expectingMenuSelection = false;
                } catch (error) {
                    console.error('Error fetching account info:', error.response ? error.response.data : error);
                }
            } 
            
            // Handle incorrect option (not 1-6)
            else if (text && sessions[phoneNumber].expectingMenuSelection) {
                // If the user provides an invalid option
                await axios.post(WHATSAPP_API_URL, {
                    messaging_product: 'whatsapp',
                    to: phoneNumber,
                    type: 'text',
                    text: {
                        body: 'Incorrect option. Please enter a valid option from the menu.'
                    }
                }, {
                    headers: {
                        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });

                console.log('Incorrect option sent to:', phoneNumber);
            }

            // If the user enters "1" without seeing the menu or without asking for "help" first
            else if (text === '1' && !sessions[phoneNumber].expectingMenuSelection) {
                // Notify the user that they need to request the menu first
                await axios.post(WHATSAPP_API_URL, {
                    messaging_product: 'whatsapp',
                    to: phoneNumber,
                    type: 'text',
                    text: {
                        body: 'Please request the menu by typing "help" to access options.'
                    }
                }, {
                    headers: {
                        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });

                console.log('Prompted user to request the menu first:', phoneNumber);
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
        }
    } else {
        res.sendStatus(404);
    }

    // Respond to WhatsApp API with success
    res.sendStatus(200);
});

module.exports = router;
