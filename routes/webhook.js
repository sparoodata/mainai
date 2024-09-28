const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const router = express.Router();

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const sessions = {};

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

    console.log('Webhook received:', JSON.stringify(body, null, 2));

    if (body.object === 'whatsapp_business_account') {
        const entry = body.entry[0];
        const changes = entry.changes[0];

        if (changes.value.contacts) {
            const contact = changes.value.contacts[0];
            const contactPhoneNumber = `+${contact.wa_id}`;
            const profileName = contact.profile.name;

            console.log(`Profile name received: ${profileName} for phone number: ${contactPhoneNumber}`);

            const user = await User.findOne({ phoneNumber: contactPhoneNumber });
            if (user) {
                if (profileName) {
                    user.profileName = profileName;
                    await user.save();
                    console.log(`Profile name updated to ${profileName} for user ${contactPhoneNumber}`);
                }
            } else {
                console.log(`No user found for phone: ${contactPhoneNumber}`);
            }
        }

        if (changes.value.messages) {
            const message = changes.value.messages[0];
            const fromNumber = message.from;
            const phoneNumber = `+${fromNumber}`;
            const text = message.text ? message.text.body.trim() : null;
            const interactive = message.interactive || null;

            if (!sessions[fromNumber]) {
                sessions[fromNumber] = { action: null };
            }

            if (text && text.toLowerCase() === 'help') {
                try {
                    sessions[fromNumber].action = null;

                    const interactiveMenu = {
                        messaging_product: 'whatsapp',
                        to: fromNumber,
                        type: 'interactive',
                        interactive: {
                            type: 'list',
                            header: { type: 'text', text: 'Choose an Option' },
                            body: { text: 'Please select an option from the list below:' },
                            footer: { text: 'Powered by your rental app' },
                            action: {
                                button: 'Select Option',
                                sections: [{
                                    title: 'Menu Options',
                                    rows: [
                                        { id: 'account_info', title: 'Account Info', description: 'View your account details' },
                                        { id: 'manage', title: 'Manage', description: 'Manage your rental account' },
                                        { id: 'transactions', title: 'Transactions', description: 'View your transaction history' },
                                        { id: 'apartment_info', title: 'Apartment Info', description: 'View information about your apartment' },
                                        { id: 'unit_info', title: 'Unit Info', description: 'View information about your unit' },
                                        { id: 'tenants_info', title: 'Tenants Info', description: 'View information about your tenants' }
                                    ]
                                }]
                            }
                        }
                    };

                    await axios.post(WHATSAPP_API_URL, interactiveMenu, {
                        headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
                    });
                } catch (error) {
                    console.error('Error sending interactive menu:', error.response ? error.response.data : error);
                }
            }

            else if (interactive) {
                const interactiveType = interactive.type;
                let selectedOption = null;

                if (interactiveType === 'list_reply') {
                    selectedOption = interactive.list_reply.id;
                } else if (interactiveType === 'button_reply') {
                    selectedOption = interactive.button_reply.id;
                }

                if (selectedOption === 'account_info') {
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
                                text: { body: accountInfoMessage }
                            }, {
                                headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
                            });
                        } else {
                            await axios.post(WHATSAPP_API_URL, {
                                messaging_product: 'whatsapp',
                                to: fromNumber,
                                type: 'text',
                                text: { body: 'No account information found for this number.' }
                            }, {
                                headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
                            });
                        }
                    } catch (error) {
                        console.error('Error fetching account info:', error.response ? error.response.data : error);
                    }
                }

                else if (selectedOption === 'manage') {
                    try {
                        const manageMenu = {
                            messaging_product: 'whatsapp',
                            to: fromNumber,
                            type: 'interactive',
                            interactive: {
                                type: 'button',
                                body: { text: 'What would you like to manage?' },
                                action: {
                                    buttons: [
                                        { type: 'reply', reply: { id: 'manage_properties', title: 'Manage Properties' } },
                                        { type: 'reply', reply: { id: 'manage_units', title: 'Manage Units' } },
                                        { type: 'reply', reply: { id: 'manage_tenants', title: 'Manage Tenants' } }
                                    ]
                                }
                            }
                        };

                        await axios.post(WHATSAPP_API_URL, manageMenu, {
                            headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
                        });
                    } catch (error) {
                        console.error('Error sending manage options:', error);
                    }
                }

                else if (selectedOption === 'manage_tenants') {
                    try {
                        const tenantMenu = {
                            messaging_product: 'whatsapp',
                            to: fromNumber,
                            type: 'interactive',
                            interactive: {
                                type: 'button',
                                body: { text: 'Manage Tenants Options:' },
                                action: {
                                    buttons: [
                                        { type: 'reply', reply: { id: 'onboard_tenant', title: 'Onboard Tenant' } },
                                        { type: 'reply', reply: { id: 'edit_tenant', title: 'Edit Tenant' } },
                                        { type: 'reply', reply: { id: 'offboard_tenant', title: 'Offboard Tenant' } }
                                    ]
                                }
                            }
                        };

                        await axios.post(WHATSAPP_API_URL, tenantMenu, {
                            headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
                        });
                    } catch (error) {
                        console.error('Error sending tenant options:', error);
                    }
                }

                else if (selectedOption === 'onboard_tenant') {
                    try {
                        const linkButton = {
                            messaging_product: 'whatsapp',
                            to: fromNumber,
                            type: 'interactive',
                            interactive: {
                                type: 'button',
                                body: { text: 'Click below to onboard a tenant' },
                                action: {
                                    buttons: [
                                        { type: 'url', url: `https://defiant-stone-tail.glitch.me/addtenant/${fromNumber}`, title: 'Onboard Tenant' }
                                    ]
                                }
                            }
                        };

                        await axios.post(WHATSAPP_API_URL, linkButton, {
                            headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
                        });
                    } catch (error) {
                        console.error('Error sending onboard link:', error);
                    }
                }
            }
        }
    }
    res.sendStatus(200);
});

// Onboarding tenant via link and authorization message
router.get('/addtenant/:phoneNumber', async (req, res) => {
    const phoneNumber = req.params.phoneNumber;
    try {
        await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            type: 'template',
            template: {
                name: 'authorize',
                language: { code: 'en' }
            }
        }, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
        });

        // Handle 'Yes' response from user for authorization
        if (/* user responds with 'Yes' */) {
            res.send(`
                <html>
                <body>
                    <h1>Onboard Tenant</h1>
                    <form>
                        <!-- Form HTML for tenant onboarding -->
                    </form>
                </body>
                </html>
            `);
        } else {
            res.send('Authorization failed or not provided.');
        }
    } catch (error) {
        console.error('Error sending authorization template:', error);
    }
});

module.exports = router;
