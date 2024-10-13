const express = require('express');
const axios = require('axios');
const User = require('../models/User'); // Assuming you have a User model
const Tenant = require('../models/Tenant'); // Assuming you have a Tenant model
const router = express.Router();

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST; // Your Glitch project URL

// Session management to track user interactions
const sessions = {}; // This will track the state of each user's session
let userResponses = {}; // Store user responses for buttons like 'Yes_authorize'

// Helper function to shorten URLs
async function shortenUrl(longUrl) {
    try {
        const response = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl));
        return response.data;
    } catch (error) {
        console.error('Error shortening URL:', error.response ? error.response.data : error);
        return longUrl; // Fallback to long URL if shortener fails
    }
}

// Webhook verification for WhatsApp API
router.get('/', (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('Webhook verified successfully');
            res.status(200).send(challenge);
        } else {
            console.error('Webhook verification failed');
            res.sendStatus(403);
        }
    }
});

// Webhook event handling
router.post('/', async (req, res) => {
    const body = req.body;

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

            // Handle interactive button reply
            if (interactive && interactive.type === 'button_reply') {
                const buttonReplyId = interactive.button_reply.id; // e.g., 'Yes_authorize' or 'No_authorize'
                console.log(`Button reply received: ${buttonReplyId} from ${fromNumber}`);

                // Store the response in the in-memory object
                userResponses[fromNumber] = buttonReplyId;
            }

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

                    // Send WhatsApp button menu
                    const buttonMenu = {
                        messaging_product: 'whatsapp',
                        to: fromNumber,
                        type: 'interactive',
                        interactive: {
                            type: 'button',
                            header: {
                                type: 'text',
                                text: 'Choose an Option'
                            },
                            body: {
                                text: 'Please select an option below:'
                            },
                            footer: {
                                text: 'Powered by your rental app'
                            },
                            action: {
                                buttons: [
                                    {
                                        type: 'reply',
                                        reply: {
                                            id: 'account_info', // Custom identifier for option 1
                                            title: 'Account Info'
                                        }
                                    },
                                    {
                                        type: 'reply',
                                        reply: {
                                            id: 'manage',
                                            title: 'Manage'
                                        }
                                    },
                                    {
                                        type: 'reply',
                                        reply: {
                                            id: 'transactions',
                                            title: 'Transactions'
                                        }
                                    }
                                ]
                            }
                        }
                    };

                    // Send the button menu message
                    await axios.post(WHATSAPP_API_URL, buttonMenu, {
                        headers: {
                            'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    console.log('Button menu sent to:', fromNumber);
                } catch (error) {
                    console.error('Error sending button menu:', error.response ? error.response.data : error);
                }
            }

            // Handle interactive message responses
            else if (interactive) {
                const selectedOption = interactive.button_reply.id; // This is the payload of the button response

                // Process the selected option
                if (selectedOption === 'account_info') {
                    // Fetch and send user account info
                    try {
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

                // Handle 'Rent Paid' option
                else if (selectedOption === 'rent_paid') {
                    // Ask for tenant ID
                    sessions[fromNumber].action = 'rent_paid';
                    await sendMessage(fromNumber, 'Please provide the Tenant ID to confirm rent payment.');
                }

                // Handle other menu options (Manage, Transactions)
                else if (selectedOption === 'manage') {
                    await sendManageSubmenu(fromNumber);
                } else if (selectedOption === 'transactions') {
                    // Handle "Transactions" option here
                } else if (selectedOption === 'manage_properties') {
                    await sendPropertyOptions(fromNumber);
                } else if (selectedOption === 'manage_units') {
                    await sendUnitOptions(fromNumber);
                } else if (selectedOption === 'manage_tenants') {
                    await sendTenantOptions(fromNumber);
                } else if (selectedOption === 'add_property') {
                    await sendPropertyLink(fromNumber, 'addproperty');
                } else if (selectedOption === 'edit_property') {
                    await sendPropertyLink(fromNumber, 'editproperty');
                } else if (selectedOption === 'remove_property') {
                    await sendPropertyLink(fromNumber, 'removeproperty');
                } else if (selectedOption === 'add_unit') {
                    await sendPropertyLink(fromNumber, 'addunit');
                } else if (selectedOption === 'edit_unit') {
                    await sendPropertyLink(fromNumber, 'editunit');
                } else if (selectedOption === 'remove_unit') {
                    await sendPropertyLink(fromNumber, 'removeunit');
                } else if (selectedOption === 'add_tenant') {
                    await sendPropertyLink(fromNumber, 'addtenant');
                } else if (selectedOption === 'edit_tenant') {
                    await sendPropertyLink(fromNumber, 'edittenant');
                } else if (selectedOption === 'remove_tenant') {
                    await sendPropertyLink(fromNumber, 'removetenant');
                }
            }

            // Handle text input when expecting tenant ID for rent payment
            else if (sessions[fromNumber].action === 'rent_paid' && text) {
                const tenantId = text.trim();
                try {
                    const tenant = await Tenant.findOne({ tenant_id: tenantId });
                    if (tenant) {
                        tenant.status = 'PAID';
                        await tenant.save();

                        await sendMessage(fromNumber, `Rent payment confirmed for Tenant ID: ${tenantId}.`);
                        console.log(`Tenant rent status updated to PAID for Tenant ID: ${tenantId}`);

                        // Reset action
                        sessions[fromNumber].action = null;
                    } else {
                        await sendMessage(fromNumber, `Tenant with ID "${tenantId}" not found.`);
                    }
                } catch (error) {
                    console.error('Error updating rent status:', error);
                    await sendMessage(fromNumber, 'Failed to confirm rent payment. Please try again.');
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

// Helper function to wait for the user response
async function waitForUserResponse(phoneNumber) {
    return new Promise((resolve) => {
        const intervalId = setInterval(() => {
            if (userResponses[phoneNumber]) {
                const response = userResponses[phoneNumber];
                clearInterval(intervalId);
                resolve(response);
            }
        }, 1000); // Poll every second
    });
}

// Helper function to send the manage submenu
async function sendManageSubmenu(phoneNumber) {
    const buttonMenu = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'interactive',
        interactive: {
            type: 'button',
            header: {
                type: 'text',
                text: 'Manage Options'
            },
            body: {
                text: 'Please select an option below:'
            },
            action: {
                buttons: [
                    {
                        type: 'reply',
                        reply: {
                            id: 'manage_properties',
                            title: 'Manage Properties'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'manage_units',
                            title: 'Manage Units'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'manage_tenants',
                            title: 'Manage Tenants'
                        }
                    }
                ]
            }
        }
    };

    await axios.post(WHATSAPP_API_URL, buttonMenu, {
        headers: {
            'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });
}

// Property Options (Add, Edit, Remove)
async function sendPropertyOptions(phoneNumber) {
    const buttonMenu = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'interactive',
        interactive: {
            type: 'button',
            header: {
                type: 'text',
                text: 'Property Options'
            },
            body: {
                text: 'Please select an option:'
            },
            action: {
                buttons: [
                    {
                        type: 'reply',
                        reply: {
                            id: 'add_property',
                            title: 'Add Property'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'edit_property',
                            title: 'Edit Property'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'remove_property',
                            title: 'Remove Property'
                        }
                    }
                ]
            }
        }
    };

    await axios.post(WHATSAPP_API_URL, buttonMenu, {
        headers: {
            'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });
}

// Units Options (Add, Edit, Remove)
async function sendUnitOptions(phoneNumber) {
    const buttonMenu = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'interactive',
        interactive: {
            type: 'button',
            header: {
                type: 'text',
                text: 'Unit Options'
            },
            body: {
                text: 'Please select an option:'
            },
            action: {
                buttons: [
                    {
                        type: 'reply',
                        reply: {
                            id: 'add_unit',
                            title: 'Add Unit'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'edit_unit',
                            title: 'Edit Unit'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'remove_unit',
                            title: 'Remove Unit'
                        }
                    }
                ]
            }
        }
    };

    await axios.post(WHATSAPP_API_URL, buttonMenu, {
        headers: {
            'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });
}

// Tenants Options (Add, Edit, Remove)
async function sendTenantOptions(phoneNumber) {
    const buttonMenu = {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'interactive',
        interactive: {
            type: 'button',
            header: {
                type: 'text',
                text: 'Tenant Options'
            },
            body: {
                text: 'Please select an option:'
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
                            id: 'edit_tenant',
                            title: 'Edit Tenant'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'remove_tenant',
                            title: 'Remove Tenant'
                        }
                    }
                ]
            }
        }
    };

    await axios.post(WHATSAPP_API_URL, buttonMenu, {
        headers: {
            'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });
}

const Authorize = require('../models/Authorize'); // Assuming you have an Authorize model

// Send the property/unit/tenant link with _id from 'authorizes' collection
async function sendPropertyLink(phoneNumber, action) {
    try {
        // Find the document in the 'authorizes' collection based on the phone number
        const authorizeRecord = await Authorize.findOne({ phoneNumber: phoneNumber });

        if (!authorizeRecord) {
            console.error(`No authorization record found for phone number: ${phoneNumber}`);
            await sendMessage(phoneNumber, 'Authorization record not found. Please contact support.');
            return;
        }

        // Use the _id from the document to construct the long URL
        const longUrl = `${GLITCH_HOST}/${action}/${authorizeRecord._id}`;
        const shortUrl = await shortenUrl(longUrl); // Get the shortened URL

        // Send the shortened URL to the user
        await sendMessage(phoneNumber, `Proceed: ${shortUrl}`);
    } catch (error) {
        console.error('Error fetching authorization record:', error);
        await sendMessage(phoneNumber, 'Failed to retrieve authorization record. Please try again.');
    }
}

module.exports = {
    router,
    waitForUserResponse,
};
