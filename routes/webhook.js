const express = require('express');
const axios = require('axios');
const User = require('../models/User'); // Assuming you have a User model
const Tenant = require('../models/Tenant'); // Assuming you have a Tenant model
const router = express.Router();

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Session management to track user interactions
const sessions = {}; // This will track the state of each user's session

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
            const interactive = message.interactive || null; // For interactive messages (list/button)
            
            // Initialize session if not existing
            if (!sessions[phoneNumber]) {
                sessions[phoneNumber] = { expectingMenuSelection: false };
            }

            // Log the received message
            console.log(`Received message from ${phoneNumber}: ${text}`);

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
                                                description: 'Manage your rental account (Add/Update/Delete tenants)'
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

            // Handle interactive message responses
            else if (interactive) {
                const interactiveType = interactive.type;
                let selectedOption = null;

                // Handle list reply
                if (interactiveType === 'list_reply') {
                    selectedOption = interactive.list_reply.id; // The ID of the selected option
                }

                // Process the selected option
                if (selectedOption === 'manage') {
                    // Send another interactive menu for managing tenants
                    try {
                        const manageMenu = {
                            messaging_product: 'whatsapp',
                            to: phoneNumber,
                            type: 'interactive',
                            interactive: {
                                type: 'button',
                                body: {
                                    text: 'Manage Tenants: Choose an action'
                                },
                                action: {
                                    buttons: [
                                        {
                                            type: 'reply',
                                            reply: {
                                                id: 'add_tenant',
                                                title: 'Add Tenant'
                                            }
                                        },
                                        {
                                            type: 'reply',
                                            reply: {
                                                id: 'update_tenant',
                                                title: 'Update Tenant'
                                            }
                                        },
                                        {
                                            type: 'reply',
                                            reply: {
                                                id: 'delete_tenant',
                                                title: 'Delete Tenant'
                                            }
                                        }
                                    ]
                                }
                            }
                        };

                        await axios.post(WHATSAPP_API_URL, manageMenu, {
                            headers: {
                                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                                'Content-Type': 'application/json'
                            }
                        });

                        console.log('Manage tenants menu sent to:', phoneNumber);
                    } catch (error) {
                        console.error('Error sending manage tenants menu:', error.response ? error.response.data : error);
                    }
                }

                // Handle tenant management actions (add, update, delete)
                else if (selectedOption === 'add_tenant') {
                    sessions[phoneNumber].action = 'add_tenant';
                    await sendMessage(phoneNumber, 'Please provide the tenant name.');
                } else if (selectedOption === 'update_tenant') {
                    sessions[phoneNumber].action = 'update_tenant';
                    await sendMessage(phoneNumber, 'Please provide the tenant ID and the updated name.');
                } else if (selectedOption === 'delete_tenant') {
                    sessions[phoneNumber].action = 'delete_tenant';
                    await sendMessage(phoneNumber, 'Please provide the tenant ID to delete.');
                }

                // Handle text input based on action (add/update/delete)
                else if (sessions[phoneNumber].action === 'add_tenant' && text) {
                    try {
                        const newTenant = new Tenant({ name: text });
                        await newTenant.save();
                        await sendMessage(phoneNumber, `Tenant "${text}" added successfully.`);
                    } catch (error) {
                        console.error('Error adding tenant:', error);
                        await sendMessage(phoneNumber, 'Failed to add tenant. Please try again.');
                    }
                } else if (sessions[phoneNumber].action === 'update_tenant' && text) {
                    const [tenantId, updatedName] = text.split(','); // Example input: "123,John Doe"
                    try {
                        const tenant = await Tenant.findById(tenantId);
                        if (tenant) {
                            tenant.name = updatedName;
                            await tenant.save();
                            await sendMessage(phoneNumber, `Tenant "${tenantId}" updated successfully.`);
                        } else {
                            await sendMessage(phoneNumber, `Tenant with ID "${tenantId}" not found.`);
                        }
                    } catch (error) {
                        console.error('Error updating tenant:', error);
                        await sendMessage(phoneNumber, 'Failed to update tenant. Please try again.');
                    }
                } else if (sessions[phoneNumber].action === 'delete_tenant' && text) {
                    try {
                        const tenant = await Tenant.findByIdAndDelete(text);
                        if (tenant) {
                            await sendMessage(phoneNumber, `Tenant with ID "${text}" deleted successfully.`);
                        } else {
                            await sendMessage(phoneNumber, `Tenant with ID "${text}" not found.`);
                        }
                    } catch (error) {
                        console.error('Error deleting tenant:', error);
                        await sendMessage(phoneNumber, 'Failed to delete tenant. Please try again.');
                    }
                }
            } else {
                console.log('Received non-interactive message or invalid interaction.');
            }
        }
    } else {
        res.sendStatus(404);
    }

    // Respond to WhatsApp API with success
    res.sendStatus(200);
});

// Helper function to send a WhatsApp message
async function sendMessage(phoneNumber, message) {
    await axios.post(WHATSAPP_API_URL, {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'text',
        text: {
            body: message
        }
    }, {
        headers: {
            'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });
}

module.exports = router;
