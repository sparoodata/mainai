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

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;

const sessions = {};
let userResponses = {};

async function shortenUrl(longUrl) {
  try {
    const response = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl));
    return response.data;
  } catch (error) {
    console.error('Error shortening URL:', error.response ? error.response.data : error);
    return longUrl;
  }
}

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

router.get('/', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post('/', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    if (value.contacts) {
      const contact = value.contacts[0];
      const phoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile.name;
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
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      if (interactive && interactive.type === 'button_reply') {
        userResponses[fromNumber] = interactive.button_reply.id;
      }

      if (!sessions[fromNumber]) sessions[fromNumber] = { action: null };

      if (text) {
        if (sessions[fromNumber].action === 'add_property_name') {
          sessions[fromNumber].propertyData = { name: text };
          await sendMessage(fromNumber, '🏠 *Step 2/5*: Please provide the number of units.');
          sessions[fromNumber].action = 'add_property_units';
        } else if (sessions[fromNumber].action === 'add_property_units') {
          sessions[fromNumber].propertyData.units = text;
          await sendMessage(fromNumber, '🏠 *Step 3/5*: Please provide the address.');
          sessions[fromNumber].action = 'add_property_address';
        } else if (sessions[fromNumber].action === 'add_property_address') {
          sessions[fromNumber].propertyData.address = text;
          await sendMessage(fromNumber, '🏠 *Step 4/5*: Please provide the total amount.');
          sessions[fromNumber].action = 'add_property_totalAmount';
        } else if (sessions[fromNumber].action === 'add_property_totalAmount') {
          sessions[fromNumber].propertyData.totalAmount = text;
          const { name, units, address, totalAmount } = sessions[fromNumber].propertyData;

          const response = await axios.post(`${GLITCH_HOST}/addproperty`, { phoneNumber, property_name: name, units, address, totalAmount });
          const propertyId = response.data.propertyId;

          const sessionId = `${fromNumber}_${Date.now()}`;
          sessions[fromNumber].sessionId = sessionId;
          sessions[fromNumber].entityId = propertyId;
          sessions[fromNumber].entity = 'property';

          const longUrl = `${GLITCH_HOST}/upload-image/${sessionId}`;
          const shortUrl = await shortenUrl(longUrl);
          await sendMessage(fromNumber, `✅ *Property Added*: ${name}\n📸 *Step 5/5*: Upload an image here: ${shortUrl}`);
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].propertyData;
        } else if (sessions[fromNumber].action === 'add_unit_property') {
          const propertyIndex = parseInt(text) - 1;
          const properties = sessions[fromNumber].properties;
          if (propertyIndex >= 0 && propertyIndex < properties.length) {
            sessions[fromNumber].unitData = { propertyId: properties[propertyIndex]._id };
            await sendMessage(fromNumber, '🚪 *Step 2/5*: Please provide the unit number.');
            sessions[fromNumber].action = 'add_unit_number';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid property number.');
          }
        } else if (sessions[fromNumber].action === 'add_unit_number') {
          sessions[fromNumber].unitData.unitNumber = text;
          await sendMessage(fromNumber, '🚪 *Step 3/5*: Please provide the rent amount.');
          sessions[fromNumber].action = 'add_unit_rent';
        } else if (sessions[fromNumber].action === 'add_unit_rent') {
          sessions[fromNumber].unitData.rentAmount = text;
          await sendMessage(fromNumber, '🚪 *Step 4/5*: Please provide the floor (optional, type "N/A" if not applicable).');
          sessions[fromNumber].action = 'add_unit_floor';
        } else if (sessions[fromNumber].action === 'add_unit_floor') {
          sessions[fromNumber].unitData.floor = text === 'N/A' ? null : text;
          await sendMessage(fromNumber, '🚪 *Step 5/5*: Please provide the size in sq ft (optional, type "N/A" if not applicable).');
          sessions[fromNumber].action = 'add_unit_size';
        } else if (sessions[fromNumber].action === 'add_unit_size') {
          sessions[fromNumber].unitData.size = text === 'N/A' ? null : text;
          const { propertyId, unitNumber, rentAmount, floor, size } = sessions[fromNumber].unitData;

          const response = await axios.post(`${GLITCH_HOST}/addunit`, { phoneNumber, propertyId, unit_number: unitNumber, rent_amount: rentAmount, floor, size });
          const unitId = response.data.unitId;

          const sessionId = `${fromNumber}_${Date.now()}`;
          sessions[fromNumber].sessionId = sessionId;
          sessions[fromNumber].entityId = unitId;
          sessions[fromNumber].entity = 'unit';

          const longUrl = `${GLITCH_HOST}/upload-image/${sessionId}`;
          const shortUrl = await shortenUrl(longUrl);
          await sendMessage(fromNumber, `✅ *Unit Added*: ${unitNumber}\n📸 Upload an image here: ${shortUrl}`);
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].unitData;
          delete sessions[fromNumber].properties;
        } else if (sessions[fromNumber].action === 'add_tenant_name') {
          sessions[fromNumber].tenantData = { name: text };
          await sendMessage(fromNumber, '👥 *Step 2/6*: Please provide the property name.');
          sessions[fromNumber].action = 'add_tenant_property';
        } else if (sessions[fromNumber].action === 'add_tenant_property') {
          sessions[fromNumber].tenantData.propertyName = text;
          await promptUnitSelection(fromNumber);
          sessions[fromNumber].action = 'add_tenant_unit';
        } else if (sessions[fromNumber].action === 'add_tenant_unit') {
          const unitIndex = parseInt(text) - 1;
          const units = sessions[fromNumber].units;
          if (unitIndex >= 0 && unitIndex < units.length) {
            sessions[fromNumber].tenantData.unitAssigned = units[unitIndex]._id;
            await sendMessage(fromNumber, '👥 *Step 4/6*: Please provide the lease start date (YYYY-MM-DD).');
            sessions[fromNumber].action = 'add_tenant_lease';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid unit number.');
          }
        } else if (sessions[fromNumber].action === 'add_tenant_lease') {
          sessions[fromNumber].tenantData.lease_start = text;
          await sendMessage(fromNumber, '👥 *Step 5/6*: Please provide the deposit amount.');
          sessions[fromNumber].action = 'add_tenant_deposit';
        } else if (sessions[fromNumber].action === 'add_tenant_deposit') {
          sessions[fromNumber].tenantData.deposit = text;
          await sendMessage(fromNumber, '👥 *Step 6/6*: Please provide the rent amount.');
          sessions[fromNumber].action = 'add_tenant_rent';
        } else if (sessions[fromNumber].action === 'add_tenant_rent') {
          sessions[fromNumber].tenantData.rent_amount = text;
          const { name, propertyName, unitAssigned, lease_start, deposit, rent_amount } = sessions[fromNumber].tenantData;

          const response = await axios.post(`${GLITCH_HOST}/addtenant`, { phoneNumber, name, propertyName, unitAssigned, lease_start, deposit, rent_amount });
          const tenantId = response.data.tenantId;

          const sessionId = `${fromNumber}_${Date.now()}`;
          sessions[fromNumber].sessionId = sessionId;
          sessions[fromNumber].entityId = tenantId;
          sessions[fromNumber].entity = 'tenant';

          const longUrl = `${GLITCH_HOST}/upload-image/${sessionId}`;
          const shortUrl = await shortenUrl(longUrl);
          await sendMessage(fromNumber, `✅ *Tenant Added*: ${name}\n📸 Upload photo and ID proof here: ${shortUrl}`);
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].tenantData;
          delete sessions[fromNumber].units;
        } else if (text.toLowerCase() === 'help') {
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
          await axios.post(WHATSAPP_API_URL, buttonMenu, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
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

        if (selectedOption === 'add_property') {
          await sendMessage(fromNumber, '🏠 *Step 1/5*: Please provide the property name.');
          sessions[fromNumber].action = 'add_property_name';
        } else if (selectedOption === 'add_unit') {
          await promptPropertySelection(fromNumber, 'add_unit');
          sessions[fromNumber].action = 'add_unit_property';
        } else if (selectedOption === 'add_tenant') {
          await sendMessage(fromNumber, '👥 *Step 1/6*: Please provide the tenant name.');
          sessions[fromNumber].action = 'add_tenant_name';
        } else if (selectedOption === 'manage') {
          await sendManageSubmenu(fromNumber);
        }
        // Add other interactive options as needed...
      }
    }
  }
  res.sendStatus(200);
});

async function promptPropertySelection(phoneNumber, action) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Properties Found* \nAdd a property first.');
    return;
  }

  let propertyList = `*🏠 Select a Property* \nReply with the number of the property:\n━━━━━━━━━━━━━━━\n`;
  properties.forEach((property, index) => {
    propertyList += `${index + 1}. *${property.name}* \n   _Address_: ${property.address}\n`;
  });
  propertyList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, propertyList);
  sessions[phoneNumber].properties = properties;
}

async function promptUnitSelection(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const units = await Unit.find({ userId: user._id });
  if (!units.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Units Found* \nAdd a unit first.');
    return;
  }

  let unitList = `*🚪 Select a Unit* \nReply with the number of the unit:\n━━━━━━━━━━━━━━━\n`;
  units.forEach((unit, index) => {
    unitList += `${index + 1}. *${unit.unitNumber}*\n`;
  });
  unitList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, unitList);
  sessions[phoneNumber].units = units;
}

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
          { type: 'reply', reply: { id: 'add_property', title: '➕ Add Property' } },
          { type: 'reply', reply: { id: 'add_unit', title: '➕ Add Unit' } },
          { type: 'reply', reply: { id: 'add_tenant', title: '➕ Add Tenant' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

module.exports = {
  router,
  sendMessage,
};