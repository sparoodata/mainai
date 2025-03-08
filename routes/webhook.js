// webhook.js
const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Authorize = require('../models/Authorize');
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const router = express.Router();

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;

// Session management to track user interactions
const sessions = {};
let userResponses = {};

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
      ? "You are an AI assistant helping a user with commands for a rental management app. Suggest using *Help* to see the menu or assist with their query."
      : "You are an AI agent for a rental management app. If the user needs help with commands, suggest using *Help* to see the menu. Otherwise, respond naturally to the message.";

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
    return '⚠️ *Sorry*, I encountered an error. Please try again or type *Help* for assistance.';
  }
}

// Helper function to send a WhatsApp message (text only)
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

// Helper function to send an image with a caption
async function sendImageMessage(phoneNumber, imageUrl, caption) {
  try {
    await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'image',
      image: {
        link: imageUrl,
        caption: caption,
      },
    }, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`Image message sent to ${phoneNumber} with URL: ${imageUrl}`);
  } catch (err) {
    console.error('Error sending image message:', err.response ? err.response.data : err);
    await sendMessage(phoneNumber, '⚠️ *Error* \nFailed to send image. Here’s the info without the image:\n' + caption);
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
        }
      } else {
        console.log(`No user found for phone: ${contactPhoneNumber}`);
      }
    }

    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from; // e.g., "918885305097"
      const phoneNumber = `+${fromNumber}`; // e.g., "+918885305097"
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
      console.log(`Current session state for ${fromNumber}: ${JSON.stringify(sessions[fromNumber])}`);

      if (text) {
        console.log(`Processing text input: ${text} for ${fromNumber}`);
        if (sessions[fromNumber].action === 'select_property') {
          console.log(`Property selection received: ${text} from ${fromNumber}`);
          const propertyIndex = parseInt(text) - 1;
          const properties = sessions[fromNumber].properties;

          if (propertyIndex >= 0 && propertyIndex < properties.length) {
            const selectedProperty = properties[propertyIndex];
            console.log(`Selected property: ${selectedProperty.name} (ID: ${selectedProperty._id})`);
            await promptTenantSelection(fromNumber, 'edittenant', selectedProperty._id);
            sessions[fromNumber].action = 'select_tenant_to_edit';
            sessions[fromNumber].propertyId = selectedProperty._id;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid property number.');
          }
        } else if (sessions[fromNumber].action === 'select_tenant_to_edit') {
          console.log(`Tenant selection received: ${text} from ${fromNumber}`);
          const tenantIndex = parseInt(text) - 1;
          const tenants = sessions[fromNumber].tenants;

          if (tenantIndex >= 0 && tenantIndex < tenants.length) {
            const selectedTenant = tenants[tenantIndex];
            console.log(`Selected tenant: ${selectedTenant.name} (ID: ${selectedTenant._id})`);
            await sendPropertyLink(fromNumber, 'edittenant', selectedTenant._id);
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].propertyId;
            delete sessions[fromNumber].tenants;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid tenant number.');
          }
        } else if (sessions[fromNumber].action === 'select_property_to_remove') {
          console.log(`Property to remove selection received: ${text} from ${fromNumber}`);
          const propertyIndex = parseInt(text) - 1;
          const properties = sessions[fromNumber].properties;

          if (propertyIndex >= 0 && propertyIndex < properties.length) {
            const selectedProperty = properties[propertyIndex];
            console.log(`Selected property to remove: ${selectedProperty.name} (ID: ${selectedProperty._id})`);
            await confirmPropertyRemoval(fromNumber, selectedProperty);
            sessions[fromNumber].action = 'confirm_property_removal';
            sessions[fromNumber].propertyToRemove = selectedProperty;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid property number.');
          }
        } else if (sessions[fromNumber].action === 'select_unit_to_remove') {
          console.log(`Unit to remove selection received: ${text} from ${fromNumber}`);
          const unitIndex = parseInt(text) - 1;
          const units = sessions[fromNumber].units;

          if (unitIndex >= 0 && unitIndex < units.length) {
            const selectedUnit = units[unitIndex];
            console.log(`Selected unit to remove: ${selectedUnit.unitNumber} (ID: ${selectedUnit._id})`);
            await confirmUnitRemoval(fromNumber, selectedUnit);
            sessions[fromNumber].action = 'confirm_unit_removal';
            sessions[fromNumber].unitToRemove = selectedUnit;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid unit number.');
          }
        } else if (sessions[fromNumber].action === 'select_tenant_to_remove') {
          console.log(`Tenant to remove selection received: ${text} from ${fromNumber}`);
          const tenantIndex = parseInt(text) - 1;
          const tenants = sessions[fromNumber].tenants;

          if (tenantIndex >= 0 && tenantIndex < tenants.length) {
            const selectedTenant = tenants[tenantIndex];
            console.log(`Selected tenant to remove: ${selectedTenant.name} (ID: ${selectedTenant._id})`);
            await confirmTenantRemoval(fromNumber, selectedTenant);
            sessions[fromNumber].action = 'confirm_tenant_removal';
            sessions[fromNumber].tenantToRemove = selectedTenant;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid tenant number.');
          }
        } else if (sessions[fromNumber].action === 'rent_paid') {
          const tenantId = text.trim();
          try {
            const tenant = await Tenant.findOne({ tenant_id: tenantId });
            if (tenant) {
              tenant.status = 'paid';
              await tenant.save();
              await sendMessage(fromNumber, `✅ *Rent Payment Confirmed* \nTenant ID: *${tenantId}*\nStatus updated to *Paid*.`);
              console.log(`Tenant rent status updated to paid for Tenant ID: ${tenantId}`);
              sessions[fromNumber].action = null;
            } else {
              await sendMessage(fromNumber, `⚠️ *Tenant Not Found* \nNo tenant found with ID: *${tenantId}*.`);
            }
          } catch (error) {
            console.error('Error updating rent status:', error);
            await sendMessage(fromNumber, '❌ *Error* \nFailed to confirm rent payment. Please try again.');
          }
        } else if (sessions[fromNumber].action === 'select_property_for_info') {
          console.log(`Property info selection received: ${text} from ${fromNumber}`);
          const propertyIndex = parseInt(text) - 1;
          const properties = sessions[fromNumber].properties;

          if (propertyIndex >= 0 && propertyIndex < properties.length) {
            const selectedProperty = properties[propertyIndex];
            console.log(`Selected property: ${selectedProperty.name} (ID: ${selectedProperty._id})`);
            await sendPropertyInfo(fromNumber, selectedProperty);
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].properties;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid property number.');
          }
        } else if (sessions[fromNumber].action === 'select_unit_for_info') {
          console.log(`Unit info selection received: ${text} from ${fromNumber}`);
          const unitIndex = parseInt(text) - 1;
          const units = sessions[fromNumber].units;

          if (unitIndex >= 0 && unitIndex < units.length) {
            const selectedUnit = units[unitIndex];
            console.log(`Selected unit: ${selectedUnit.unitNumber} (ID: ${selectedUnit._id})`);
            await sendUnitInfo(fromNumber, selectedUnit);
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].units;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid unit number.');
          }
        } else if (sessions[fromNumber].action === 'select_tenant_for_info') {
          console.log(`Tenant info selection received: ${text} from ${fromNumber}`);
          const tenantIndex = parseInt(text) - 1;
          const tenants = sessions[fromNumber].tenants;

          if (tenantIndex >= 0 && tenantIndex < tenants.length) {
            const selectedTenant = tenants[tenantIndex];
            console.log(`Selected tenant: ${selectedTenant.name} (ID: ${selectedTenant._id})`);
            await sendTenantInfo(fromNumber, selectedTenant);
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].tenants;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid tenant number.');
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
                header: { type: 'text', text: '🏠 Rental Management' },
                body: { text: '*Welcome!* Please select an option below:' },
                footer: { text: 'Powered by Your Rental App' },
                action: {
                  buttons: [
                    { type: 'reply', reply: { id: 'account_info', title: '👤 Account Info' } },
                    { type: 'reply', reply: { id: 'manage', title: '🛠️ Manage' } },
                    { type: 'reply', reply: { id: 'tools', title: '🧰 Tools' } },
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

        // Handle Yes/No confirmation for removals
        if (sessions[fromNumber].action === 'confirm_property_removal' && selectedOption === 'yes_remove_property') {
          const property = sessions[fromNumber].propertyToRemove;
          try {
            await Property.findByIdAndDelete(property._id);
            await sendMessage(fromNumber, `✅ *Success* \nProperty *${property.name}* has been deleted successfully!`);
            console.log(`Property ${property._id} deleted`);
          } catch (error) {
            console.error(`Error deleting property ${property._id}:`, error);
            await sendMessage(fromNumber, `❌ *Error* \nFailed to delete property *${property.name}*. Please try again.`);
          }
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].propertyToRemove;
        } else if (sessions[fromNumber].action === 'confirm_property_removal' && selectedOption === 'no_remove_property') {
          await sendMessage(fromNumber, `ℹ️ *Canceled* \nRemoval of property *${sessions[fromNumber].propertyToRemove.name}* has been canceled.`);
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].propertyToRemove;
        } else if (sessions[fromNumber].action === 'confirm_unit_removal' && selectedOption === 'yes_remove_unit') {
          const unit = sessions[fromNumber].unitToRemove;
          try {
            await Unit.findByIdAndDelete(unit._id);
            await sendMessage(fromNumber, `✅ *Success* \nUnit *${unit.unitNumber}* has been deleted successfully!`);
            console.log(`Unit ${unit._id} deleted`);
          } catch (error) {
            console.error(`Error deleting unit ${unit._id}:`, error);
            await sendMessage(fromNumber, `❌ *Error* \nFailed to delete unit *${unit.unitNumber}*. Please try again.`);
          }
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].unitToRemove;
        } else if (sessions[fromNumber].action === 'confirm_unit_removal' && selectedOption === 'no_remove_unit') {
          await sendMessage(fromNumber, `ℹ️ *Canceled* \nRemoval of unit *${sessions[fromNumber].unitToRemove.unitNumber}* has been canceled.`);
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].unitToRemove;
        } else if (sessions[fromNumber].action === 'confirm_tenant_removal' && selectedOption === 'yes_remove_tenant') {
          const tenant = sessions[fromNumber].tenantToRemove;
          try {
            await Tenant.findByIdAndDelete(tenant._id);
            await sendMessage(fromNumber, `✅ *Success* \nTenant *${tenant.name}* has been deleted successfully!`);
            console.log(`Tenant ${tenant._id} deleted`);
          } catch (error) {
            console.error(`Error deleting tenant ${tenant._id}:`, error);
            await sendMessage(fromNumber, `❌ *Error* \nFailed to delete tenant *${tenant.name}*. Please try again.`);
          }
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].tenantToRemove;
        } else if (sessions[fromNumber].action === 'confirm_tenant_removal' && selectedOption === 'no_remove_tenant') {
          await sendMessage(fromNumber, `ℹ️ *Canceled* \nRemoval of tenant *${sessions[fromNumber].tenantToRemove.name}* has been canceled.`);
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].tenantToRemove;
        }

        // Handle menu options
        else if (selectedOption === 'account_info') {
          try {
            const user = await User.findOne({ phoneNumber });
            if (user) {
              const accountInfoMessage = `
*👤 Account Information*
━━━━━━━━━━━━━━━
📞 *Phone*: ${user.phoneNumber}
✅ *Verified*: ${user.verified ? 'Yes' : 'No'}
🧑 *Profile Name*: ${user.profileName || 'N/A'}
📅 *Registration Date*: ${user.registrationDate ? user.registrationDate.toLocaleDateString() : 'N/A'}
💰 *Subscription*: ${user.subscription}
━━━━━━━━━━━━━━━
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
                text: { body: '⚠️ *No Account Found* \nNo account information is available for this number.' },
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
          await sendMessage(fromNumber, '💰 *Confirm Rent Payment* \nPlease provide the *Tenant ID* to mark their rent as paid.');
        } else if (selectedOption === 'manage') {
          await sendManageSubmenu(fromNumber);
        } else if (selectedOption === 'tools') {
          await sendToolsSubmenu(fromNumber);
        } else if (selectedOption === 'reports') {
          await sendReportsSubmenu(fromNumber);
        } else if (selectedOption === 'maintenance') {
          await sendMessage(fromNumber, '🔧 *Maintenance* \nMaintenance features coming soon!');
        } else if (selectedOption === 'info') {
          await sendInfoSubmenu(fromNumber);
        } else if (selectedOption === 'property_info') {
          await promptPropertyInfoSelection(fromNumber);
        } else if (selectedOption === 'unit_info') {
          await promptUnitInfoSelection(fromNumber);
        } else if (selectedOption === 'tenant_info') {
          await promptTenantInfoSelection(fromNumber);
        } else if (selectedOption === 'financial_summary') {
          await sendMessage(fromNumber, '💵 *Financial Summary* \nGenerating financial report... (Coming soon!)');
        } else if (selectedOption === 'occupancy_report') {
          await sendMessage(fromNumber, '🏠 *Occupancy Report* \nGenerating occupancy report... (Coming soon!)');
        } else if (selectedOption === 'maintenance_trends') {
          await sendMessage(fromNumber, '🔧 *Maintenance Trends* \nGenerating maintenance trends report... (Coming soon!)');
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
          await promptPropertyRemoval(fromNumber);
        } else if (selectedOption === 'add_unit') {
          await sendPropertyLink(fromNumber, 'addunit');
        } else if (selectedOption === 'edit_unit') {
          await sendPropertyLink(fromNumber, 'editunit');
        } else if (selectedOption === 'remove_unit') {
          await promptUnitRemoval(fromNumber);
        } else if (selectedOption === 'add_tenant') {
          await sendPropertyLink(fromNumber, 'addtenant');
        } else if (selectedOption === 'edit_tenant') {
          console.log(`Edit Tenant selected by ${fromNumber}`);
          await promptPropertySelection(fromNumber, 'edittenant');
        } else if (selectedOption === 'remove_tenant') {
          await promptTenantRemoval(fromNumber);
        }
      }
    }
  } else {
    return res.sendStatus(404);
  }

  res.sendStatus(200);
});

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
        reject(new Error('⏰ *Timed Out* \nAuthorization timed out.'));
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
      header: { type: 'text', text: '🛠️ Manage Options' },
      body: { text: '*What would you like to manage?* Select an option below:' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'manage_properties', title: '🏠 Properties' } },
          { type: 'reply', reply: { id: 'manage_units', title: '🚪 Units' } },
          { type: 'reply', reply: { id: 'manage_tenants', title: '👥 Tenants' } },
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

// Helper function to send the tools submenu
async function sendToolsSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🧰 Tools' },
      body: { text: '*Select a tool:*' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'reports', title: '📊 Reports' } },
          { type: 'reply', reply: { id: 'maintenance', title: '🔧 Maintenance' } },
          { type: 'reply', reply: { id: 'info', title: 'ℹ️ Info' } },
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

// Helper function to send the reports submenu
async function sendReportsSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '📊 Reports' },
      body: { text: '*Select a report type:*' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'financial_summary', title: '💵 Financial Summary' } },
          { type: 'reply', reply: { id: 'occupancy_report', title: '🏠 Occupancy Report' } },
          { type: 'reply', reply: { id: 'maintenance_trends', title: '🔧 Maintenance Trends' } },
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

// Helper function to send the info submenu
async function sendInfoSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'ℹ️ Info' },
      body: { text: '*Select what you want info about:*' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'property_info', title: '🏠 Property Info' } },
          { type: 'reply', reply: { id: 'unit_info', title: '🚪 Unit Info' } },
          { type: 'reply', reply: { id: 'tenant_info', title: '👥 Tenant Info' } },
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

// Helper function to prompt property info selection
async function promptPropertyInfoSelection(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Properties Found* \nNo properties available to display.');
    return;
  }

  let propertyList = `*🏠 Select a Property for Info* \nReply with the number of the property:\n━━━━━━━━━━━━━━━\n`;
  properties.forEach((property, index) => {
    propertyList += `${index + 1}. *${property.name}* \n   _Address_: ${property.address}\n`;
  });
  propertyList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, propertyList);
  console.log(`Property list sent to ${phoneNumber}: ${propertyList}`);

  sessions[phoneNumber] = { action: 'select_property_for_info', properties };
}

// Helper function to send property info
async function sendPropertyInfo(phoneNumber, property) {
  console.log(`Sending property info for ${property.name} to ${phoneNumber}`);
  // Assuming images contains direct URLs; if it references an Image model, uncomment the below
  // const Image = require('../models/Image');
  // let imageUrl = 'https://via.placeholder.com/150';
  // if (property.images && property.images.length > 0) {
  //   const imageDoc = await Image.findById(property.images[0]);
  //   imageUrl = imageDoc ? imageDoc.url : imageUrl;
  // }
  const imageUrl = property.images && property.images.length > 0 
    ? property.images[0] // Direct URL assumption
    : 'https://via.placeholder.com/150';

  const caption = `
*🏠 Property Details*
━━━━━━━━━━━━━━━
*Name*: ${property.name}
*Address*: ${property.address}
*Units*: ${property.units}
*Total Amount*: $${property.totalAmount}
*ID*: ${property._id}
*Created At*: ${property.createdAt ? new Date(property.createdAt).toLocaleDateString() : 'N/A'}
━━━━━━━━━━━━━━━
  `;

  await sendImageMessage(phoneNumber, imageUrl, caption);
}

// Helper function to prompt unit info selection
async function promptUnitInfoSelection(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const units = await Unit.find({ userId: user._id }).populate('property');
  if (!units.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Units Found* \nNo units available to display.');
    return;
  }

  let unitList = `*🚪 Select a Unit for Info* \nReply with the number of the unit:\n━━━━━━━━━━━━━━━\n`;
  units.forEach((unit, index) => {
    unitList += `${index + 1}. *${unit.unitNumber}* \n   _Property_: ${unit.property ? unit.property.name : 'N/A'}\n`;
  });
  unitList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, unitList);

  sessions[phoneNumber] = { action: 'select_unit_for_info', units };
}

// Helper function to send unit info
async function sendUnitInfo(phoneNumber, unit) {
  // Assuming images contains direct URLs; if it references an Image model, uncomment the below
  // const Image = require('../models/Image');
  // let imageUrl = 'https://via.placeholder.com/150';
  // if (unit.images && unit.images.length > 0) {
  //   const imageDoc = await Image.findById(unit.images[0]);
  //   imageUrl = imageDoc ? imageDoc.url : imageUrl;
  // }
  const imageUrl = unit.images && unit.images.length > 0 
    ? unit.images[0] // Direct URL assumption
    : 'https://via.placeholder.com/150';

  const caption = `
*🚪 Unit Details*
━━━━━━━━━━━━━━━
*Unit Number*: ${unit.unitNumber}
*Property*: ${unit.property ? unit.property.name : 'N/A'}
*Rent Amount*: $${unit.rentAmount}
*Floor*: ${unit.floor || 'N/A'}
*Size*: ${unit.size ? unit.size + ' sq ft' : 'N/A'}
*ID*: ${unit._id}
*Created At*: ${unit.createdAt ? new Date(unit.createdAt).toLocaleDateString() : 'N/A'}
━━━━━━━━━━━━━━━
  `;
  await sendImageMessage(phoneNumber, imageUrl, caption);
}

// Helper function to prompt tenant info selection
async function promptTenantInfoSelection(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const tenants = await Tenant.find({ userId: user._id }).populate('unitAssigned');
  if (!tenants.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Tenants Found* \nNo tenants available to display.');
    return;
  }

  let tenantList = `*👥 Select a Tenant for Info* \nReply with the number of the tenant:\n━━━━━━━━━━━━━━━\n`;
  tenants.forEach((tenant, index) => {
    tenantList += `${index + 1}. *${tenant.name}* \n   _Unit_: ${tenant.unitAssigned ? tenant.unitAssigned.unitNumber : 'N/A'}\n`;
  });
  tenantList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, tenantList);

  sessions[phoneNumber] = { action: 'select_tenant_for_info', tenants };
}

// Helper function to send tenant info
async function sendTenantInfo(phoneNumber, tenant) {
  const imageUrl = tenant.photo || 'https://via.placeholder.com/150';
  const caption = `
*👥 Tenant Details*
━━━━━━━━━━━━━━━
*Name*: ${tenant.name}
*Phone Number*: ${tenant.phoneNumber}
*Unit*: ${tenant.unitAssigned ? tenant.unitAssigned.unitNumber : 'N/A'}
*Property*: ${tenant.propertyName}
*Lease Start*: ${tenant.lease_start ? new Date(tenant.lease_start).toLocaleDateString() : 'N/A'}
*Deposit*: $${tenant.deposit}
*Rent Amount*: $${tenant.rent_amount}
*Tenant ID*: ${tenant.tenant_id}
*Email*: ${tenant.email || 'N/A'}
*ID Proof*: ${tenant.idProof ? 'Available' : 'N/A'}
*Created At*: ${tenant.createdAt ? new Date(tenant.createdAt).toLocaleDateString() : 'N/A'}
━━━━━━━━━━━━━━━
  `;
  await sendImageMessage(phoneNumber, imageUrl, caption);
}

// Helper function for Property Options (Add, Edit, Remove)
async function sendPropertyOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🏠 Property Management' },
      body: { text: '*Manage your properties:* Select an option:' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_property', title: '➕ Add Property' } },
          { type: 'reply', reply: { id: 'edit_property', title: '✏️ Edit Property' } },
          { type: 'reply', reply: { id: 'remove_property', title: '🗑️ Remove Property' } },
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
      header: { type: 'text', text: '🚪 Unit Management' },
      body: { text: '*Manage your units:* Select an option:' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_unit', title: '➕ Add Unit' } },
          { type: 'reply', reply: { id: 'edit_unit', title: '✏️ Edit Unit' } },
          { type: 'reply', reply: { id: 'remove_unit', title: '🗑️ Remove Unit' } },
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

// Helper function for Tenant Options (Add, Edit, Remove)
async function sendTenantOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '👥 Tenant Management' },
      body: { text: '*Manage your tenants:* Select an option:' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_tenant', title: '➕ Add Tenant' } },
          { type: 'reply', reply: { id: 'edit_tenant', title: '✏️ Edit Tenant' } },
          { type: 'reply', reply: { id: 'remove_tenant', title: '🗑️ Remove Tenant' } },
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

// Helper function to prompt property selection (for editing)
async function promptPropertySelection(phoneNumber, action) {
  console.log(`Prompting property selection for ${phoneNumber}`);
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Properties Found* \nAdd a property first to manage tenants.');
    return;
  }

  let propertyList = `*🏠 Select a Property* \nReply with the number of the property:\n━━━━━━━━━━━━━━━\n`;
  properties.forEach((property, index) => {
    propertyList += `${index + 1}. *${property.name}* \n   _Address_: ${property.address}\n`;
  });
  propertyList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, propertyList);
  console.log(`Property list sent to ${phoneNumber}: ${propertyList}`);

  sessions[phoneNumber] = { action: 'select_property', properties };
}

// Helper function to prompt tenant selection (for editing)
async function promptTenantSelection(phoneNumber, action, propertyId) {
  console.log(`Prompting tenant selection for property ${propertyId} for ${phoneNumber}`);
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const tenants = await Tenant.find({ userId: user._id })
    .populate('unitAssigned')
    .then(tenants => tenants.filter(tenant => tenant.unitAssigned && tenant.unitAssigned.property.toString() === propertyId.toString()));

  if (!tenants.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Tenants Found* \nNo tenants are assigned to this property.');
    return;
  }

  let tenantList = `*👥 Select a Tenant to Edit* \nReply with the number of the tenant:\n━━━━━━━━━━━━━━━\n`;
  tenants.forEach((tenant, index) => {
    tenantList += `${index + 1}. *${tenant.name}* \n   _ID_: ${tenant.tenant_id || tenant._id}\n`;
  });
  tenantList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, tenantList);
  console.log(`Tenant list sent to ${phoneNumber}: ${tenantList}`);

  sessions[phoneNumber].tenants = tenants;
}

// Helper function to send property link (for add/edit actions)
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

    await sendMessage(phoneNumber, `🔗 *Action Link* \nPlease proceed using this link: *${shortUrl}*`);
    console.log(`OTP verification link sent to ${phoneNumber} for action: ${action}`);
  } catch (error) {
    console.error('Error in sendPropertyLink:', error);
    await sendMessage(phoneNumber, '❌ *Error* \nFailed to generate the action link. Please try again.');
  }
}

// Helper function to prompt property removal
async function promptPropertyRemoval(phoneNumber) {
  console.log(`Prompting property removal selection for ${phoneNumber}`);
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Properties Found* \nNo properties available to remove.');
    return;
  }

  let propertyList = `*🏠 Select a Property to Remove* \nReply with the number of the property:\n━━━━━━━━━━━━━━━\n`;
  properties.forEach((property, index) => {
    propertyList += `${index + 1}. *${property.name}* \n   _Address_: ${property.address}\n`;
  });
  propertyList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, propertyList);
  console.log(`Property removal list sent to ${phoneNumber}: ${propertyList}`);

  sessions[phoneNumber] = { action: 'select_property_to_remove', properties };
}

// Helper function to confirm property removal
async function confirmPropertyRemoval(phoneNumber, property) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const units = await Unit.find({ property: property._id });
  if (units.length > 0) {
    await sendMessage(phoneNumber, `⚠️ *Cannot Remove Property* \nProperty *${property.name}* has ${units.length} unit(s) assigned. Please remove the units first.`);
    sessions[phoneNumber].action = null;
    return;
  }

  const confirmationMessage = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `🗑️ *Confirm Property Removal*\nAre you sure you want to remove *${property.name}*?\n*WARNING*: This action is permanent and cannot be undone.` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_remove_property', title: '✅ Yes' } },
          { type: 'reply', reply: { id: 'no_remove_property', title: '❌ No' } },
        ],
      },
    },
  };

  await axios.post(WHATSAPP_API_URL, confirmationMessage, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  console.log(`Property removal confirmation sent to ${phoneNumber} for property: ${property.name}`);
}

// Helper function to prompt unit removal
async function promptUnitRemoval(phoneNumber) {
  console.log(`Prompting unit removal selection for ${phoneNumber}`);
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const units = await Unit.find({ userId: user._id });
  if (!units.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Units Found* \nNo units available to remove.');
    return;
  }

  let unitList = `*🚪 Select a Unit to Remove* \nReply with the number of the unit:\n━━━━━━━━━━━━━━━\n`;
  units.forEach((unit, index) => {
    unitList += `${index + 1}. *${unit.unitNumber}* \n   _ID_: ${unit._id}\n`;
  });
  unitList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, unitList);
  console.log(`Unit removal list sent to ${phoneNumber}: ${unitList}`);

  sessions[phoneNumber] = { action: 'select_unit_to_remove', units };
}

// Helper function to confirm unit removal
async function confirmUnitRemoval(phoneNumber, unit) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const tenants = await Tenant.find({ unitAssigned: unit._id });
  if (tenants.length > 0) {
    await sendMessage(phoneNumber, `⚠️ *Cannot Remove Unit* \nUnit *${unit.unitNumber}* has ${tenants.length} tenant(s) assigned. Please remove the tenants first.`);
    sessions[phoneNumber].action = null;
    return;
  }

  const confirmationMessage = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `🗑️ *Confirm Unit Removal*\nAre you sure you want to remove *${unit.unitNumber}*?\n*WARNING*: This action is permanent and cannot be undone.` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_remove_unit', title: '✅ Yes' } },
          { type: 'reply', reply: { id: 'no_remove_unit', title: '❌ No' } },
        ],
      },
    },
  };

  await axios.post(WHATSAPP_API_URL, confirmationMessage, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  console.log(`Unit removal confirmation sent to ${phoneNumber} for unit: ${unit.unitNumber}`);
}

// Helper function to prompt tenant removal
async function promptTenantRemoval(phoneNumber) {
  console.log(`Prompting tenant removal selection for ${phoneNumber}`);
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const tenants = await Tenant.find({ userId: user._id });
  if (!tenants.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Tenants Found* \nNo tenants available to remove.');
    return;
  }

  let tenantList = `*👥 Select a Tenant to Remove* \nReply with the number of the tenant:\n━━━━━━━━━━━━━━━\n`;
  tenants.forEach((tenant, index) => {
    tenantList += `${index + 1}. *${tenant.name}* \n   _ID_: ${tenant.tenant_id || tenant._id}\n`;
  });
  tenantList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, tenantList);
  console.log(`Tenant removal list sent to ${phoneNumber}: ${tenantList}`);

  sessions[phoneNumber] = { action: 'select_tenant_to_remove', tenants };
}

// Helper function to confirm tenant removal
async function confirmTenantRemoval(phoneNumber, tenant) {
  const confirmationMessage = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `🗑️ *Confirm Tenant Removal*\nAre you sure you want to remove *${tenant.name}*?\n*WARNING*: This action is permanent and cannot be undone.` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_remove_tenant', title: '✅ Yes' } },
          { type: 'reply', reply: { id: 'no_remove_tenant', title: '❌ No' } },
        ],
      },
    },
  };

  await axios.post(WHATSAPP_API_URL, confirmationMessage, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  console.log(`Tenant removal confirmation sent to ${phoneNumber} for tenant: ${tenant.name}`);
}

// Export the module
module.exports = {
  router,
  waitForUserResponse,
  userResponses,
  sessions,
  sendMessage,
};