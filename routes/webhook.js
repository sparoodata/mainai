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

                    // Send WhatsApp interactive list menu
                    const interactiveMenu = {
                        messaging_product: 'whatsapp',
                        to: phoneNumber,
                        type: 'interactive',
                        interactive: {
                            type: 'list',
                            header: {
                                type: 'text',
                                text: 'Choose an Option'
                            },
                            body: {
                                text: 'Please select an option from the list below:'
                            },
                            footer: {
                                text: 'Powered by your rental app'
                            },
                            action: {
                                button: 'Select Option',
                                sections: [
                                    {
                                        title: 'Menu Options',
                                        rows: [
                                            {
                                                id: 'account_info', // Custom identifier for option 1
                                                title: 'Account Info',
                                                description: 'View your account details'
                                            },
                                            {
                                                id: 'manage',
                                                title: 'Manage',
                                                description: 'Manage your rental account'
                                            },
                                            {
                                                id: 'transactions',
                                                title: 'Transactions',
                                                description: 'View your transaction history'
                                            },
                                            {
                                                id: 'apartment_info',
                                                title: 'Apartment Info',
                                                description: 'View information about your apartment'
                                            },
                                            {
                                                id: 'unit_info',
                                                title: 'Unit Info',
                                                description: 'View information about your unit'
                                            },
                                            {
                                                id: 'tenants_info',
                                                title: 'Tenants Info',
                                                description: 'View information about your tenants'
                                            }
                                        ]
                                    }
                                ]
                            }
                        }
                    };

                    // Send the interactive menu message
                    await axios.post(WHATSAPP_API_URL, interactiveMenu, {
                        headers: {
                            'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    console.log('Interactive menu sent to:', phoneNumber);
                } catch (error) {
                    console.error('Error sending interactive menu:', error.response ? error.response.data : error);
                }
            }

            // Handle user selection from the menu
            else if (payload) {
                console.log(payload);
               
                if (payload === 'account_info') {
                    // Fetch and send user account info
                    try {
                        console.log(phoneNumber);
                        const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });

                        if (user) {
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

                // Handle other menu options (e.g., 'manage', 'transactions', etc.)
                else if (payload === 'manage') {
                    // Handle "Manage" option here
                    // ...
                } else if (payload === 'transactions') {
                    // Handle "Transactions" option here
                    // ...
                } else if (payload === 'apartment_info') {
                    // Handle "Apartment Info" option here
                    // ...
                } else if (payload === 'unit_info') {
                    // Handle "Unit Info" option here
                    // ...
                } else if (payload === 'tenants_info') {
                    // Handle "Tenants Info" option here
                    // ...
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
