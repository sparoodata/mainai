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

        // Handle contacts to capture profile name
        if (changes.value.contacts) {
            const contact = changes.value.contacts[0];
            const contactPhoneNumber = `+${contact.wa_id}`;
            const profileName = contact.profile.name;

            // Log the profileName for debugging purposes
            console.log(`Profile name received: ${profileName} for phone number: ${contactPhoneNumber}`);

            // Find the user by phone number
            const user = await User.findOne({ phoneNumber: contactPhoneNumber });

            if (user) {
                console.log(`User found: ${user.phoneNumber}`);

                // Update user's profile name if profileName exists
                if (profileName) {
                    user.profileName = profileName;
                    await user.save();
                    console.log(`Profile name updated to ${profileName} for user ${contactPhoneNumber}`);
                } else {
                    console.log(`No profile name available to update for user ${contactPhoneNumber}`);
                }
            } else {
                console.log(`No user found for phone: ${contactPhoneNumber}`);
            }
        }

        if (changes.value.messages) {
            const message = changes.value.messages[0];
            const fromNumber = message.from; // e.g., '918885305097'
            const phoneNumber = `+${fromNumber}`; // '+918885305097'
            const text = message.text ? message.text.body.trim() : null; // Message body
            const interactive = message.interactive || null; // For interactive messages (list/button)

            // Initialize session if not existing
            if (!sessions[fromNumber]) {
                sessions[fromNumber] = { action: null };
            }

            // Log the received message
            console.log(`Received message from ${phoneNumber}: ${text}`);

            // Handle "help" message (case-insensitive)
            if (text && text.toLowerCase() === 'help') {
                try {
                    // Set session state to expect menu selection
                    sessions[fromNumber].action = null;

                    // Send WhatsApp interactive list menu
                    const interactiveMenu = {
                        messaging_product: 'whatsapp',
                        to: fromNumber,
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

                    console.log('Interactive menu sent to:', fromNumber);
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

                // Handle button reply
                else if (interactiveType === 'button_reply') {
                    selectedOption = interactive.button_reply.id; // This is the payload of the button response
                }

                // Process the selected option
                if (selectedOption === 'account_info') {
                    // Fetch and send user account info
                    try {
                        console.log(phoneNumber);
                        const user = await User.findOne({ phoneNumber });

                        if (user) {
                            const accountInfoMessage = `
*Account Info*:
- Phone Number: ${user.phoneNumber}
- Verified: ${user.verified ? 'Yes' : 'No'}
- Profile Name: ${user.profileName || 'N/A'}
- Registration Date: ${user.registrationDate ? user.registrationDate.toLocaleString() : 'N/A'}
- Verified Date: ${user.verifiedDate ? user.verifiedDate.toLocaleString() : 'N/A'}
                            `;

                            await axios.post(WHATSAPP_API_URL, {
                                messaging_product: 'whatsapp',
                                to: fromNumber,
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
                                to: fromNumber,
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

                // Handle 'Manage' option
                else if (selectedOption === 'manage') {
                    const manageMenu = {
                        messaging_product: 'whatsapp',
                        to: fromNumber,
                        type: 'interactive',
                        interactive: {
                            type: 'list',
                            header: { type: 'text', text: 'Manage Options' },
                            body: { text: 'Please select an option to manage:' },
                            action: {
                                button: 'Manage',
                                sections: [{
                                    title: 'Manage Options',
                                    rows: [
                                        { id: 'manage_properties', title: 'Manage Properties', description: 'Manage property details' },
                                        { id: 'manage_units', title: 'Manage Units', description: 'Manage unit details' },
                                        { id: 'manage_tenants', title: 'Manage Tenants', description: 'Manage tenant details' }
                                    ]
                                }]
                            }
                        }
                    };

                    await axios.post(WHATSAPP_API_URL, manageMenu, {
                        headers: {
                            'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    sessions[fromNumber].action = 'manage';
                }

                else if (selectedOption === 'manage_tenants') {
                    // Handle Manage Tenants option and show sub-menu
                    const tenantManageMenu = {
                        messaging_product: 'whatsapp',
                        to: fromNumber,
                        type: 'interactive',
                        interactive: {
                            type: 'list',
                            header: { type: 'text', text: 'Tenant Management' },
                            body: { text: 'Please select an option to manage tenants:' },
                            action: {
                                button: 'Manage Tenants',
                                sections: [{
                                    title: 'Tenant Actions',
                                    rows: [
                                        { id: 'onboard_tenant', title: 'Onboard Tenant', description: 'Add new tenant' },
                                        { id: 'edit_tenant', title: 'Edit Tenant', description: 'Edit tenant details' },
                                        { id: 'offboard_tenant', title: 'Offboard Tenant', description: 'Remove tenant' }
                                    ]
                                }]
                            }
                        }
                    };

                    await axios.post(WHATSAPP_API_URL, tenantManageMenu, {
                        headers: {
                            'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    sessions[fromNumber].action = 'manage_tenants';
                }

                else if (selectedOption === 'onboard_tenant') {
                    sessions[fromNumber].action = 'onboard_tenant';
                    await sendMessage(fromNumber, 'Please provide the tenant name:');
                }
            }

            else if (sessions[fromNumber].action === 'onboard_tenant' && text) {
                // Collect tenant information in sequence
                if (!sessions[fromNumber].tenantInfo) {
                    sessions[fromNumber].tenantInfo = { name: text };
                    await sendMessage(fromNumber, 'Please provide the tenant phone number:');
                } else if (!sessions[fromNumber].tenantInfo.phoneNumber) {
                    sessions[fromNumber].tenantInfo.phoneNumber = text;
                    await sendMessage(fromNumber, 'Please upload a photo of the tenant:');
                } else if (!sessions[fromNumber].tenantInfo.photo) {
                    // Assuming the user sends a media message, you can handle media attachments here
                    sessions[fromNumber].tenantInfo.photo = text; // Placeholder for media handling
                    await sendMessage(fromNumber, 'Please upload the ID proof photo:');
                } else if (!sessions[fromNumber].tenantInfo.idProof) {
                    sessions[fromNumber].tenantInfo.idProof = text; // Placeholder for media handling

                    // Save tenant to the database
                    try {
                        const newTenant = new Tenant({
                            name: sessions[fromNumber].tenantInfo.name,
                            phoneNumber: sessions[fromNumber].tenantInfo.phoneNumber,
                            photo: sessions[fromNumber].tenantInfo.photo,
                            idProof: sessions[fromNumber].tenantInfo.idProof
                        });

                        await newTenant.save();
                        await sendMessage(fromNumber, 'Tenant successfully onboarded.');

                        console.log('New tenant onboarded:', newTenant);
                        sessions[fromNumber].action = null;
                        sessions[fromNumber].tenantInfo = null; // Reset the info
                    } catch (error) {
                        console.error('Error onboarding tenant:', error);
                        await sendMessage(fromNumber, 'Failed to onboard tenant. Please try again.');
                    }
                }
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
