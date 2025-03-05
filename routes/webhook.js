// webhook.js
const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property'); // Add Property model
const Authorize = require('../models/Authorize');
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const router = express.Router();

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;

// Session management to track user interactions
const sessions = {};      // e.g., { "918885305097": { action: "select_property", properties: [...] } }
let userResponses = {};   // e.g., { "918885305097": "Yes_authorize" }

// Helper function to shorten URLs
async function shortenUrl(longUrl) {
  try {
    const response = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl));
    return response.data;
  } catch (error) {
    console.error('Error shortening URL:', error.response ? error.response.data : error);
    return longUrl;
  }
}

// Helper function to get Groq AI response
async function getGroqAIResponse(message, phoneNumber, isAssistanceMode) {
  try {
    const systemPrompt = isAssistanceMode
      ? "You are an AI assistant helping a user with commands for a rental management app. Suggest using 'Help' to see the menu or assist with their query."
      : "You are an AI agent for a rental management app. If the user needs help with commands, suggest using 'Help' to see the menu. Otherwise, respond naturally to the message.";

    const response = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error with Groq AI:', error);
    return 'Sorry, I encountered an error. Please try again or type "Help" for assistance.';
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
      return res.status(200).send(challenge);
    } else {
      console.error('Webhook verification failed');
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// Webhook event handling
router.post('/', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    if (value.contacts) {
      const contact = value.contacts[0];
      const contactPhoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile.name;
      console.log(`Profile name received: ${profileName} for phone number: ${contactPhoneNumber}`);

      const user = await User.findOne({ phoneNumber: contactPhoneNumber });
      if (user) {
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

    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;
      const phoneNumber = `+${fromNumber}`;
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      if (interactive && interactive.type === 'button_reply') {
        const buttonReplyId = interactive.button_reply.id;
        console.log(`Button reply received: ${buttonReplyId} from ${fromNumber}`);
        userResponses[fromNumber] = buttonReplyId;
      }

      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      console.log(`Received message from ${phoneNumber}: ${text}`);

      if (text) {
        if (sessions[fromNumber].action === 'select_property') {
          const propertyIndex = parseInt(text) - 1;
          const properties = sessions[fromNumber].properties;

          if (propertyIndex >= 0 && propertyIndex < properties.length) {
            const selectedProperty = properties[propertyIndex];
            await promptTenantSelection(fromNumber, 'edittenant', selectedProperty._id);
            sessions[fromNumber].action = 'select_tenant_to_edit';
            sessions[fromNumber].propertyId = selectedProperty._id;
          } else {
            await sendMessage(fromNumber, 'Invalid property selection. Please reply with a valid number.');
          }
        } else if (sessions[fromNumber].action === 'select_tenant_to_edit') {
          const tenantIndex = parseInt(text) - 1;
          const tenants = sessions[fromNumber].tenants;

          if (tenantIndex >= 0 && tenantIndex < tenants.length) {
            const selectedTenant = tenants[tenantIndex];
            await sendPropertyLink(fromNumber, 'edittenant', selectedTenant._id);
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].propertyId;
            delete sessions[fromNumber].tenants;
          } else {
            await sendMessage(fromNumber, 'Invalid tenant selection. Please reply with a valid number.');
          }
        } else if (text.toLowerCase() === 'help') {
          try {
            sessions[fromNumber].action = null;

            const buttonMenu = {
              messaging_product: 'whatsapp',
              to: fromNumber,
              type: 'interactive',
              interactive: {
                type: 'button',
                header: { type: 'text', text: 'Choose an Option' },
                body: { text: 'Please select an option below:' },
                footer: { text: 'Powered by your rental app' },
                action: {
                  buttons: [
                    { type: 'reply', reply: { id: 'account_info', title: 'Account Info' } },
                    { type: 'reply', reply: { id: 'manage', title: 'Manage' } },
                    { type: 'reply', reply: { id: 'transactions', title: 'Transactions' } },
                  ],
                },
              },
            };

            await axios.post(WHATSAPP_API_URL, buttonMenu, {
              headers: {
                'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
              },
            });

            console.log('Button menu sent to:', fromNumber);
          } catch (error) {
            console.error('Error sending button menu:', error.response ? error.response.data : error);
          }
        } else if (text.startsWith('\\')) {
          const query = text.substring(1).trim();
          const aiResponse = await getGroqAIResponse(query, phoneNumber, true);
          await sendMessage(fromNumber, aiResponse);
        } else if (!sessions[fromNumber].action) {
          const aiResponse = await getGroqAIResponse(text, phoneNumber, false);
          await sendMessage(fromNumber, aiResponse);
        }
      }

      if (interactive) {
        const selectedOption = interactive.button_reply.id;
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
                text: { body: accountInfoMessage },
              }, {
                headers: {
                  'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                  'Content-Type': 'application/json',
                },
              });
              console.log('Account info sent to:', phoneNumber);
            } else {
              await axios.post(WHATSAPP_API_URL, {
                messaging_product: 'whatsapp',
                to: fromNumber,
                type: 'text',
                text: { body: 'No account information found for this number.' },
              }, {
                headers: {
                  'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                  'Content-Type': 'application/json',
                },
              });
              console.log('No account information found for:', phoneNumber);
            }
          } catch (error) {
            console.error('Error fetching account info:', error.response ? error.response.data : error);
          }
        } else if (selectedOption === 'rent_paid') {
          sessions[fromNumber].action = 'rent_paid';
          await sendMessage(fromNumber, 'Please provide the Tenant ID to confirm rent payment.');
        } else if (selectedOption === 'manage') {
          await sendManageSubmenu(fromNumber);
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
          await promptPropertySelection(fromNumber, 'edittenant');
        } else if (selectedOption === 'remove_tenant') {
          await sendPropertyLink(fromNumber, 'removetenant');
        }
      }

      if (sessions[fromNumber].action === 'rent_paid' && text) {
        const tenantId = text.trim();
        try {
          const tenant = await Tenant.findOne({ tenant_id: tenantId });
          if (tenant) {
            tenant.status = 'paid';
            await tenant.save();
            await sendMessage(fromNumber, `Rent payment confirmed for Tenant ID: ${tenantId}.`);
            console.log(`Tenant rent status updated to paid for Tenant ID: ${tenantId}`);
            sessions[fromNumber].action = null;
          } else {
            await sendMessage(fromNumber, `Tenant with ID "${tenantId}" not found.`);
          }
        } catch (error) {
          console.error('Error updating rent status:', error);
          await sendMessage(fromNumber, 'Failed to confirm rent payment. Please try again.');
        }
      }
    }
  } else {
    return res.sendStatus(404);
  }

  res.sendStatus(200);
});

// Helper function to send a WhatsApp message
async function sendMessage(phoneNumber, message) {
  try {
    await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'text',
      text: { body: message },
    }, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Error sending WhatsApp message:', err.response ? err.response.data : err);
  }
}

// Helper function to wait for the user response (polling every second)
async function waitForUserResponse(phoneNumber, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const intervalId = setInterval(() => {
      if (userResponses[phoneNumber]) {
        const response = userResponses[phoneNumber];
        clearInterval(intervalId);
        console.log(`Captured user response: ${response} from ${phoneNumber}`);
        delete userResponses[phoneNumber];
        resolve(response);
      } else if (Date.now() - startTime >= timeout) {
        clearInterval(intervalId);
        console.error(`Authorization timed out for ${phoneNumber}`);
        reject(new Error('Authorization timed out.'));
      }
    }, 500);
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
      header: { type: 'text', text: 'Manage Options' },
      body: { text: 'Please select an option below:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'manage_properties', title: 'Manage Properties' } },
          { type: 'reply', reply: { id: 'manage_units', title: 'Manage Units' } },
          { type: 'reply', reply: { id: 'manage_tenants', title: 'Manage Tenants' } },
        ],
      },
    },
  };

  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// Helper function for Property Options (Add, Edit, Remove)
async function sendPropertyOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Property Options' },
      body: { text: 'Please select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_property', title: 'Add Property' } },
          { type: 'reply', reply: { id: 'edit_property', title: 'Edit Property' } },
          { type: 'reply', reply: { id: 'remove_property', title: 'Remove Property' } },
        ],
      },
    },
  };

  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// Helper function for Unit Options (Add, Edit, Remove)
async function sendUnitOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Unit Options' },
      body: { text: 'Please select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_unit', title: 'Add Unit' } },
          { type: 'reply', reply: { id: 'edit_unit', title: 'Edit Unit' } },
          { type: 'reply', reply: { id: 'remove_unit', title: 'Remove Unit' } },
        ],
      },
    },
  };

  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// Helper function for Reports Submenu
async function sendReportsSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Reports Options' },
      body: { text: 'Please select a report type:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'current_rent_status', title: 'Current Rent Status' } },
          { type: 'reply', reply: { id: 'tenant_info', title: 'Tenant Info' } },
          { type: 'reply', reply: { id: 'tenants_due', title: 'Tenants Due' } },
        ],
      },
    },
  };

  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  const secondButtonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'More Reports' },
      body: { text: 'More report options:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'property_details', title: 'Property Details' } },
          { type: 'reply', reply: { id: 'unit_details', title: 'Unit Details' } },
          { type: 'reply', reply: { id: 'tenant_details', title: 'Tenant Details' } },
        ],
      },
    },
  };

  await axios.post(WHATSAPP_API_URL, secondButtonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// Helper function for Tenant Options (Add, Edit, Remove)
async function sendTenantOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Tenant Options' },
      body: { text: 'Please select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_tenant', title: 'Add Tenant' } },
          { type: 'reply', reply: { id: 'edit_tenant', title: 'Edit Tenant' } },
          { type: 'reply', reply: { id: 'remove_tenant', title: 'Remove Tenant' } },
        ],
      },
    },
  };

  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// New helper function to prompt property selection
async function promptPropertySelection(phoneNumber, action) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, 'User not found.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, 'No properties found to edit tenants for.');
    return;
  }

  let propertyList = 'Select a property by replying with its number:\n';
  properties.forEach((property, index) => {
    propertyList += `${index + 1}. ${property.name} (Address: ${property.address})\n`;
  });
  await sendMessage(phoneNumber, propertyList);

  sessions[phoneNumber] = { action: 'select_property', properties };
}

// New helper function to prompt tenant selection for a specific property
async function promptTenantSelection(phoneNumber, action, propertyId) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, 'User not found.');
    return;
  }

  // Find tenants whose unitAssigned references a unit in the selected property
  const tenants = await Tenant.find({ userId: user._id })
    .populate('unitAssigned') // Populate unitAssigned to check property
    .then(tenants => tenants.filter(tenant => tenant.unitAssigned && tenant.unitAssigned.property.toString() === propertyId.toString()));

  if (!tenants.length) {
    await sendMessage(phoneNumber, 'No tenants found for this property.');
    return;
  }

  let tenantList = 'Select a tenant to edit by replying with their number:\n';
  tenants.forEach((tenant, index) => {
    tenantList += `${index + 1}. ${tenant.name} (ID: ${tenant.tenant_id || tenant._id})\n`;
  });
  await sendMessage(phoneNumber, tenantList);

  sessions[phoneNumber].tenants = tenants;
}

// Updated helper function to send property link with optional tenantId
async function sendPropertyLink(phoneNumber, action, tenantId = null) {
  console.log(`sendPropertyLink called for phoneNumber: ${phoneNumber}, action: ${action}, tenantId: ${tenantId}`);

  try {
    let authorizeRecord = await Authorize.findOne({ phoneNumber: `+${phoneNumber}` });

    if (!authorizeRecord) {
      authorizeRecord = new Authorize({
        phoneNumber: `+${phoneNumber}`,
        used: false,
        action: action,
        createdAt: new Date(),
      });
      await authorizeRecord.save();
      console.log(`New authorization record created with ID: ${authorizeRecord._id}, action: ${action}`);
    } else {
      authorizeRecord.action = action;
      authorizeRecord.used = false;
      await authorizeRecord.save();
      console.log(`Updated authorization record with ID: ${authorizeRecord._id}, action: ${action}`);
    }

    const baseUrl = `${GLITCH_HOST}/authorize/${authorizeRecord._id}`;
    const longUrl = tenantId ? `${baseUrl}?tenantId=${tenantId}` : baseUrl;
    console.log(`Long URL generated: ${longUrl}`);

    const shortUrl = await shortenUrl(longUrl);
    console.log(`Short URL generated: ${shortUrl}`);

    await sendMessage(phoneNumber, `Proceed: ${shortUrl}`);
    console.log(`OTP verification link sent to ${phoneNumber} for action: ${action}`);
  } catch (error) {
    console.error('Error in sendPropertyLink:', error);
    await sendMessage(phoneNumber, 'Failed to retrieve authorization record. Please try again.');
  }
}

// Export the module
module.exports = {
  router,
  waitForUserResponse,
  userResponses,
  sessions,
  sendMessage,
};