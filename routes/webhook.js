const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const Groq = require('groq-sdk');

const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const UploadToken = require('../models/UploadToken');

const router = express.Router();

const WHATSAPP_API_URL =
  'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;
const DEFAULT_IMAGE_URL = 'https://via.placeholder.com/150';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Helper: Shorten a URL using TinyURL
 */
async function shortenUrl(longUrl) {
  try {
    const response = await axios.post(
      'https://tinyurl.com/api-create.php?url=' +
        encodeURIComponent(longUrl)
    );
    return response.data;
  } catch (error) {
    console.error('Error shortening URL:', error);
    return longUrl;
  }
}

/**
 * Helper: Generate an upload token (valid for 15 minutes)
 */
async function generateUploadToken(phoneNumber, type, entityId) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const uploadToken = new UploadToken({
    token,
    phoneNumber,
    type,
    entityId,
    expiresAt,
  });
  await uploadToken.save();
  return token;
}

/**
 * Helper: Send a WhatsApp message using the Business API
 */
async function sendMessage(phoneNumber, message) {
  try {
    await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'text',
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error(
      'Error sending WhatsApp message:',
      err.response ? err.response.data : err
    );
  }
}

/**
 * Helper: Send image upload option button via WhatsApp
 */
async function sendImageOption(phoneNumber, type, entityId) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: {
        type: 'text',
        text:
          `📸 Add Image to ${type.charAt(0).toUpperCase() + type.slice(1)}`,
      },
      body: { text: `Would you like to upload an image for this ${type}?` },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: `upload_${type}_${entityId}`, title: 'Yes' },
          },
          {
            type: 'reply',
            reply: { id: `no_upload_${type}_${entityId}`, title: 'No' },
          },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Helper: Send a summary message with entity details
 */
async function sendSummary(phoneNumber, type, entityId, imageUrl) {
  let summary = '';
  if (type === 'property') {
    const property = await Property.findById(entityId);
    summary = `
📸 *Image*: ${imageUrl}
✅ *Property Added*
━━━━━━━━━━━━━━━
🏠 *Name*: ${property.name}
📍 *Address*: ${property.address}
🚪 *Units*: ${property.units}
💰 *Total Amount*: ${property.totalAmount}
━━━━━━━━━━━━━━━`;
  } else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('property');
    summary = `
📸 *Image*: ${imageUrl}
✅ *Unit Added*
━━━━━━━━━━━━━━━
🏠 *Property*: ${unit.property.name}
🚪 *Unit Number*: ${unit.unitNumber}
💰 *Rent Amount*: ${unit.rentAmount}
📏 *Floor*: ${unit.floor}
📐 *Size*: ${unit.size}
━━━━━━━━━━━━━━━`;
  } else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId);
    const unit = await Unit.findById(tenant.unitAssigned);
    summary = `
📸 *Image*: ${imageUrl}
✅ *Tenant Added*
━━━━━━━━━━━━━━━
👤 *Name*: ${tenant.name}
🏠 *Property*: ${tenant.propertyName}
🚪 *Unit*: ${unit.unitNumber}
📅 *Lease Start*: ${tenant.lease_start}
💵 *Deposit*: ${tenant.deposit}
💰 *Rent Amount*: ${tenant.rent_amount}
━━━━━━━━━━━━━━━`;
  }
  await sendMessage(phoneNumber, summary);
}

/**
 * Validation Helpers
 */
function isValidName(name) {
  const regex = /^[a-zA-Z0-9 ]+$/;
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.length <= 40 &&
    regex.test(name)
  );
}

function isValidAddress(address) {
  const regex = /^[a-zA-Z0-9 ]+$/;
  return (
    typeof address === 'string' &&
    address.trim().length > 0 &&
    address.length <= 40 &&
    regex.test(address)
  );
}

function isValidUnits(units) {
  const num = parseInt(units);
  return !isNaN(num) && num > 0 && Number.isInteger(num);
}

function isValidTotalAmount(amount) {
  const num = parseFloat(amount);
  return !isNaN(num) && num > 0;
}

function isValidDate(dateStr) {
  const regex = /^(\d{2})-(\d{2})-(\d{4})$/;
  if (!regex.test(dateStr)) return false;
  const [day, month, year] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return (
    date.getDate() === day &&
    date.getMonth() === month - 1 &&
    date.getFullYear() === year
  );
}

// --- Webhook Verification Endpoint ---
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

// --- Webhook POST Handler ---
router.post('/', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    // Update or create user profile
    if (value.contacts) {
      const contact = value.contacts[0];
      const contactPhoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile.name;
      const user =
        (await User.findOne({ phoneNumber: contactPhoneNumber })) ||
        new User({ phoneNumber: contactPhoneNumber });
      user.profileName = profileName || user.profileName;
      await user.save();
    }

    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;
      const phoneNumber = `+${fromNumber}`;
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      console.log(`Message from ${fromNumber}:`, { text, interactive });

      // Process interactive responses
      if (interactive) {
        if (
          interactive.type === 'list_reply' ||
          interactive.type === 'button_reply'
        ) {
          processInteractiveResponse(fromNumber, interactive);
        }
      }

      // Process text commands
      await processTextMessage(phoneNumber, text);
    }
  }
  res.sendStatus(200);
});

/**
 * Helper for processing interactive responses.
 * (In production, consider storing session state in a persistent store.)
 */
const sessions = {};
function processInteractiveResponse(fromNumber, interactive) {
  const selectedOption =
    interactive.type === 'list_reply'
      ? interactive.list_reply.id
      : interactive.button_reply.id;
  sessions[fromNumber] = sessions[fromNumber] || { action: null };
  sessions[fromNumber].selectedOption = selectedOption;
  console.log(
    `Interactive option received from ${fromNumber}: ${selectedOption}`
  );
}

/**
 * Helper for processing text messages.
 */
async function processTextMessage(phoneNumber, text) {
  // Example: Handle a simple "help" command
  if (text && text.toLowerCase() === 'help') {
    const buttonMenu = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: '🏠 Rental Management' },
        body: { text: '*Welcome!* Please select an option below:' },
        footer: { text: 'Powered by Your Rental App' },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: { id: 'account_info', title: '👤 Account Info' },
            },
            {
              type: 'reply',
              reply: { id: 'manage', title: '🛠️ Manage' },
            },
            {
              type: 'reply',
              reply: { id: 'tools', title: '🧰 Tools' },
            },
          ],
        },
      },
    };
    await axios.post(WHATSAPP_API_URL, buttonMenu, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  }
}

/**
 * Additional helper functions to send menus (e.g., property selection) can be added here.
 */
async function sendPropertySelectionMenu(phoneNumber, properties) {
  const listMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: '🏠 Select a Property' },
      body: { text: 'Please choose a property:' },
      footer: { text: 'Select from the list below' },
      action: {
        button: 'Choose Property',
        sections: [
          {
            title: 'Properties',
            rows: properties.map((p) => ({
              id: p._id.toString(),
              title: p.name.slice(0, 24),
              description: p.address.slice(0, 72),
            })),
          },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, listMenu, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// Export the router and sendMessage for use in server.js
module.exports = {
  router,
  sendMessage,
};
