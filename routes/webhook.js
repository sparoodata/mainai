const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Authorize = require('../models/Authorize');
const Groq = require('groq-sdk');
const crypto = require('crypto');
const { sanitize } = require('express-mongo-sanitize');

const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;

const sessions = {};
let userResponses = {};

// Secure message sending
async function sendMessage(phoneNumber, message) {
  try {
    await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'text',
      text: { body: message.slice(0, 4096) },
    }, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.message);
  }
}

// Webhook verification
router.get('/', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook event handling
router.post('/', async (req, res) => {
  const body = sanitize(req.body);
  if (body.object !== 'whatsapp_business_account') {
    return res.sendStatus(404);
  }

  const entry = body.entry[0];
  const changes = entry.changes[0];
  const value = changes.value;

  if (value.contacts) {
    const contact = value.contacts[0];
    const phoneNumber = `+${contact.wa_id}`;
    const profileName = contact.profile.name.slice(0, 100);

    const user = await User.findOne({ phoneNumber });
    if (user && profileName) {
      user.profileName = profileName;
      await user.save();
    }
  }

  if (value.messages) {
    const message = value.messages[0];
    const fromNumber = message.from;
    const phoneNumber = `+${fromNumber}`;
    const text = message.text?.body.trim().slice(0, 1000);
    const interactive = message.interactive;

    if (!sessions[fromNumber]) {
      sessions[fromNumber] = { action: null, lastActivity: Date.now() };
    }

    if (Date.now() - sessions[fromNumber].lastActivity > 30 * 60 * 1000) {
      delete sessions[fromNumber];
      await sendMessage(fromNumber, 'Session expired. Please start again.');
      return res.sendStatus(200);
    }
    sessions[fromNumber].lastActivity = Date.now();

    if (interactive?.type === 'button_reply') {
      const buttonReplyId = interactive.button_reply.id;
      userResponses[fromNumber] = buttonReplyId;
    }

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
          await sendMessage(fromNumber, 'Invalid property selection.');
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
          await sendMessage(fromNumber, 'Invalid tenant selection.');
        }
      } else if (sessions[fromNumber].action === 'rent_paid') {
        const tenantId = text.trim();
        const tenant = await Tenant.findOne({ tenant_id: tenantId });
        if (tenant) {
          tenant.status = 'paid';
          await tenant.save();
          await sendMessage(fromNumber, `Rent payment confirmed for Tenant ID: ${tenantId}.`);
          sessions[fromNumber].action = null;
        } else {
          await sendMessage(fromNumber, `Tenant with ID "${tenantId}" not found.`);
        }
      } else if (text.toLowerCase() === 'help') {
        const buttonMenu = {
          messaging_product: 'whatsapp',
          to: fromNumber,
          type: 'interactive',
          interactive: {
            type: 'button',
            header: { type: 'text', text: 'Choose an Option' },
            body: { text: 'Please select an option:' },
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
          timeout: 5000,
        });
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
      const validOptions = [
        'account_info', 'manage', 'transactions', 'add_property', 'edit_property', 'remove_property',
        'add_unit', 'edit_unit', 'remove_unit', 'add_tenant', 'edit_tenant', 'remove_tenant',
        'manage_properties', 'manage_units', 'manage_tenants', 'rent_paid'
      ];

      if (!validOptions.includes(selectedOption)) {
        await sendMessage(fromNumber, 'Invalid option.');
      } else if (selectedOption === 'account_info') {
        const user = await User.findOne({ phoneNumber });
        if (user) {
          const accountInfo = `
*Account Info*:
- Phone: ${user.phoneNumber}
- Verified: ${user.verified ? 'Yes' : 'No'}
- Name: ${user.profileName || 'N/A'}
          `;
          await sendMessage(fromNumber, accountInfo);
        } else {
          await sendMessage(fromNumber, 'No account found.');
        }
      } else if (selectedOption === 'rent_paid') {
        sessions[fromNumber].action = 'rent_paid';
        await sendMessage(fromNumber, 'Please provide the Tenant ID.');
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
        await promptPropertySelection(fromNumber, 'edittenant');
      } else if (selectedOption === 'remove_tenant') {
        await promptTenantRemoval(fromNumber);
      }
    }
  }

  res.sendStatus(200);
});

// Helper functions
async function getGroqAIResponse(message, phoneNumber, isAssistanceMode) {
  try {
    const systemPrompt = isAssistanceMode
      ? "You are an AI assistant for a rental management app. Suggest 'Help' for menu."
      : "You are an AI agent for a rental app. Suggest 'Help' if needed.";
    const response = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message.slice(0, 500) },
      ],
      max_tokens: 200,
      temperature: 0.7,
    });
    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error with Groq AI:', error);
    return 'Sorry, an error occurred. Try "Help" for assistance.';
  }
}

async function shortenUrl(longUrl) {
  try {
    const response = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl), {}, { timeout: 5000 });
    return response.data;
  } catch (error) {
    console.error('Error shortening URL:', error.message);
    return longUrl;
  }
}

async function sendManageSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Manage Options' },
      body: { text: 'Select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'manage_properties', title: 'Properties' } },
          { type: 'reply', reply: { id: 'manage_units', title: 'Units' } },
          { type: 'reply', reply: { id: 'manage_tenants', title: 'Tenants' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 5000,
  });
}

async function sendPropertyOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Property Options' },
      body: { text: 'Select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_property', title: 'Add' } },
          { type: 'reply', reply: { id: 'edit_property', title: 'Edit' } },
          { type: 'reply', reply: { id: 'remove_property', title: 'Remove' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 5000,
  });
}

async function sendUnitOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Unit Options' },
      body: { text: 'Select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_unit', title: 'Add' } },
          { type: 'reply', reply: { id: 'edit_unit', title: 'Edit' } },
          { type: 'reply', reply: { id: 'remove_unit', title: 'Remove' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 5000,
  });
}

async function sendTenantOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Tenant Options' },
      body: { text: 'Select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_tenant', title: 'Add' } },
          { type: 'reply', reply: { id: 'edit_tenant', title: 'Edit' } },
          { type: 'reply', reply: { id: 'remove_tenant', title: 'Remove' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 5000,
  });
}

async function promptPropertySelection(phoneNumber, action) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, 'User not found.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, 'No properties found.');
    return;
  }

  let propertyList = 'Select a property (reply with number):\n';
  properties.forEach((p, i) => propertyList += `${i + 1}. ${p.name}\n`);
  await sendMessage(phoneNumber, propertyList);
  sessions[phoneNumber] = { action: 'select_property', properties };
}

async function promptTenantSelection(phoneNumber, action, propertyId) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, 'User not found.');
    return;
  }

  const tenants = await Tenant.find({ userId: user._id })
    .populate('unitAssigned')
    .then(tenants => tenants.filter(t => t.unitAssigned && t.unitAssigned.property.toString() === propertyId.toString()));

  if (!tenants.length) {
    await sendMessage(phoneNumber, 'No tenants found.');
    return;
  }

  let tenantList = 'Select a tenant (reply with number):\n';
  tenants.forEach((t, i) => tenantList += `${i + 1}. ${t.name}\n`);
  await sendMessage(phoneNumber, tenantList);
  sessions[phoneNumber].tenants = tenants;
}

async function sendPropertyLink(phoneNumber, action, tenantId = null) {
  try {
    let authorizeRecord = await Authorize.findOne({ phoneNumber: `+${phoneNumber}` });
    if (!authorizeRecord) {
      authorizeRecord = new Authorize({
        phoneNumber: `+${phoneNumber}`,
        used: false,
        action,
        createdAt: new Date(),
      });
    } else {
      authorizeRecord.action = action;
      authorizeRecord.used = false;
    }
    await authorizeRecord.save();

    const longUrl = tenantId ? `${GLITCH_HOST}/authorize/${authorizeRecord._id}?tenantId=${tenantId}` : `${GLITCH_HOST}/authorize/${authorizeRecord._id}`;
    const shortUrl = await shortenUrl(longUrl);
    await sendMessage(phoneNumber, `Proceed: ${shortUrl}`);
  } catch (error) {
    console.error('Error sending property link:', error);
    await sendMessage(phoneNumber, 'Error generating link.');
  }
}

async function promptPropertyRemoval(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, 'User not found.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, 'No properties found.');
    return;
  }

  let propertyList = 'Select a property to remove (reply with number):\n';
  properties.forEach((p, i) => propertyList += `${i + 1}. ${p.name}\n`);
  await sendMessage(phoneNumber, propertyList);
  sessions[phoneNumber] = { action: 'select_property_to_remove', properties };
}

async function promptUnitRemoval(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, 'User not found.');
    return;
  }

  const units = await Unit.find({ userId: user._id });
  if (!units.length) {
    await sendMessage(phoneNumber, 'No units found.');
    return;
  }

  let unitList = 'Select a unit to remove (reply with number):\n';
  units.forEach((u, i) => unitList += `${i + 1}. ${u.unitNumber}\n`);
  await sendMessage(phoneNumber, unitList);
  sessions[phoneNumber] = { action: 'select_unit_to_remove', units };
}

async function promptTenantRemoval(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, 'User not found.');
    return;
  }

  const tenants = await Tenant.find({ userId: user._id });
  if (!tenants.length) {
    await sendMessage(phoneNumber, 'No tenants found.');
    return;
  }

  let tenantList = 'Select a tenant to remove (reply with number):\n';
  tenants.forEach((t, i) => tenantList += `${i + 1}. ${t.name}\n`);
  await sendMessage(phoneNumber, tenantList);
  sessions[phoneNumber] = { action: 'select_tenant_to_remove', tenants };
}

module.exports = {
  router,
  sendMessage,
};