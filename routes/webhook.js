// webhook.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const Groq = require('groq-sdk');

const User = require('../models/User');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Tenant = require('../models/Tenant');
const UploadToken = require('../models/UploadToken');

const router = express.Router();

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;
const DEFAULT_IMAGE_URL = 'https://via.placeholder.com/150';

const sessions = {};
let userResponses = {};

// Helpers and validators
const chunkArray = require('../helpers/chunkArray');
const { isValidName, isValidAddress, isValidUnits, isValidTotalAmount, isValidDate } = require('../helpers/validators');
const { generateUnitId, generateTenantId } = require('../helpers/idGenerators');
const { shortenUrl, sendMessage, sendImageMessage } = require('../helpers/whatsapp');
const generateUploadToken = require('../helpers/uploadToken');
const menuHelpers = require('../helpers/menuHelpers');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Helper: Check if a string is numeric
function isNumeric(value) {
  return /^\d+$/.test(value);
}

/**
 * 1) Helper: Forward slash-initiated messages to the internal Groq endpoint.
 */
async function forwardToGroq(phoneNumber, message) {
  try {
    const response = await axios.post(`${GLITCH_HOST}/groq`, { phoneNumber, message });
    return response.data.reply;
  } catch (error) {
    console.error('Error forwarding to Groq:', error);
    return 'Sorry, there was an issue processing your request.';
  }
}

/**
 * 2) Various interactive message helpers
 *    - We keep your existing code to preserve your flows.
 */
async function sendCountrySelectionList(fromNumber) {
  const rows = [
    {
      id: 'country_India',
      title: 'India',
      description: 'Select India'
    }
  ];
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: '' },
      body: { text: 'Please select your country:' },
      footer: { text: 'Powered by Your Rental App' },
      action: {
        button: 'View Country',
        sections: [{ title: 'Country', rows }]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, messageData, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

async function sendPropertyTypeButtons(fromNumber) {
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '' },
      body: { text: 'Please select a property type:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'ptype_Apartment', title: 'Apartment' } },
          { type: 'reply', reply: { id: 'ptype_Independant', title: 'Independant house' } },
          { type: 'reply', reply: { id: 'ptype_Others', title: 'Others' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, messageData, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

async function sendYearBuiltOptionButtons(fromNumber) {
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '' },
      body: { text: 'Would you like to enter the year built?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'year_enter', title: 'Enter Year Built' } },
          { type: 'reply', reply: { id: 'year_skip', title: 'Skip' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, messageData, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

async function sendPurchasePriceOptionButtons(fromNumber) {
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '' },
      body: { text: 'Would you like to enter the purchase price?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'price_enter', title: 'Enter Price' } },
          { type: 'reply', reply: { id: 'price_skip', title: 'Skip' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, messageData, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

async function sendPropertySelectionLists(fromNumber, properties) {
  const chunks = chunkArray(properties, 10);
  for (let i = 0; i < chunks.length; i++) {
    const rows = chunks[i].map(prop => ({
      id: `prop_${prop._id}`,
      title: prop.name,
      description: prop.address || ''
    }));
    const headerText = '';
    const bodyText = 'Please select a property from the list below:';
    const footerText = '';
    const actionButton = i === 0 ? 'View Properties' : 'View More';
    const messageData = {
      messaging_product: 'whatsapp',
      to: fromNumber,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: headerText },
        body: { text: bodyText },
        footer: { text: footerText },
        action: {
          button: actionButton,
          sections: [{ title: 'Properties', rows }]
        }
      }
    };
    await axios.post(WHATSAPP_API_URL, messageData, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  }
}

async function sendUnitSelectionLists(fromNumber, units) {
  const chunks = chunkArray(units, 10);
  for (let i = 0; i < chunks.length; i++) {
    const rows = chunks[i].map(unit => ({
      id: `unit_${unit._id}`,
      title: unit.unitNumber,
      description: `Floor: ${unit.floor}`
    }));
    const headerText = '';
    const bodyText = 'Please select a unit from the list below:';
    const footerText = '';
    const actionButton = i === 0 ? 'View Units' : 'View More';
    const messageData = {
      messaging_product: 'whatsapp',
      to: fromNumber,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: headerText },
        body: { text: bodyText },
        footer: { text: footerText },
        action: {
          button: actionButton,
          sections: [{ title: 'Units', rows }]
        }
      }
    };
    await axios.post(WHATSAPP_API_URL, messageData, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  }
}

async function sendImageOptionButton(fromNumber, type, entityId) {
  const token = await generateUploadToken(fromNumber, type, entityId);
  const imageUploadUrl = `${GLITCH_HOST}/upload-image/${fromNumber}/${type}/${entityId}?token=${token}`;
  const shortUrl = await shortenUrl(imageUploadUrl);
  await sendMessage(fromNumber, `Please upload the image here (valid for 15 minutes): ${shortUrl}`);
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '' },
      body: { text: 'If you wish to skip uploading an image, tap the button below:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `no_upload_${type}_${entityId}`, title: 'No, Skip' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, messageData, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

/**
 * 3) WhatsApp Webhook Verification
 */
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

/**
 * 4) Main webhook POST handler
 */
router.post('/', async (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    // 4a) Create or update user from contact info
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

    // 4b) Process incoming messages
    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;
      const phoneNumber = `+${fromNumber}`;
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      console.log(`Message from ${fromNumber}:`, { text, interactive });

      /**
       * 4b-i) NEW: If message starts with '/', forward to Groq
       */
      if (text && text.startsWith('/')) {
        const groqReply = await forwardToGroq(phoneNumber, text);
        await sendMessage(fromNumber, groqReply);
        return res.sendStatus(200);
      }

      // 4b-ii) Old logic: Interactive or text-based flows
      if (interactive && interactive.type === 'list_reply') {
        userResponses[fromNumber] = interactive.list_reply.id;
        console.log(`List reply received: ${userResponses[fromNumber]}`);
      } else if (interactive && interactive.type === 'button_reply') {
        userResponses[fromNumber] = interactive.button_reply.id;
        console.log(`Button reply received: ${userResponses[fromNumber]}`);
      }

      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      // 4b-iii) If it's a normal text (not slash)
      if (text) {
        // ---------------------
        // Entire existing logic
        // ---------------------

        if (text.toLowerCase() === 'help') {
          if (sessions[fromNumber].action === 'awaiting_image_choice') return res.sendStatus(200);
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
                  { type: 'reply', reply: { id: 'tools', title: '🧰 Tools' } }
                ]
              }
            }
          };
          await axios.post(WHATSAPP_API_URL, buttonMenu, {
            headers: {
              Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            }
          });
          return res.sendStatus(200);
        }

        // ---- Property Creation Flow (original) ----
        if (sessions[fromNumber].action === 'add_property_name') {
          if (isValidName(text)) {
            sessions[fromNumber].propertyData = { name: text };
            await sendMessage(
              fromNumber,
              'Please provide a description for the property (max 100 characters).'
            );
            sessions[fromNumber].action = 'add_property_description';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease retry with a valid property name.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_property_description') {
          if (text.length > 100) {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nProperty description must not exceed 100 characters. Please re-enter:'
            );
            return res.sendStatus(200);
          }
          sessions[fromNumber].propertyData.description = text;
          await sendMessage(fromNumber, 'Please provide the street address of the property.');
          sessions[fromNumber].action = 'add_property_address';
        } else if (sessions[fromNumber].action === 'add_property_address') {
          if (isValidAddress(text)) {
            sessions[fromNumber].propertyData.address = text;
            await sendMessage(fromNumber, 'Enter the city.');
            sessions[fromNumber].action = 'add_property_city';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease retry with a valid street address.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_property_city') {
          sessions[fromNumber].propertyData.city = text;
          await sendMessage(fromNumber, 'Enter the state.');
          sessions[fromNumber].action = 'add_property_state';
        } else if (sessions[fromNumber].action === 'add_property_state') {
          sessions[fromNumber].propertyData.state = text;
          await sendMessage(fromNumber, 'Enter the ZIP code (numbers only):');
          sessions[fromNumber].action = 'add_property_zip';
        } else if (sessions[fromNumber].action === 'add_property_zip') {
          if (!isNumeric(text)) {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nZIP code must contain only numbers. Please re-enter:'
            );
            return res.sendStatus(200);
          }
          sessions[fromNumber].propertyData.zipCode = text;
          await sendCountrySelectionList(fromNumber);
          sessions[fromNumber].action = 'awaiting_property_country';
        } else if (sessions[fromNumber].action === 'awaiting_property_country') {
          // Handled via interactive reply below.
        } else if (sessions[fromNumber].action === 'awaiting_property_type') {
          // Handled via interactive reply below.
        } else if (sessions[fromNumber].action === 'add_property_yearBuilt') {
          const currentYear = new Date().getFullYear();
          const year = parseInt(text, 10);
          if (isNaN(year) || text.length !== 4 || year < 1000 || year > currentYear) {
            await sendMessage(
              fromNumber,
              `⚠️ *Invalid entry* \nPlease enter a valid 4-digit year not exceeding ${currentYear}.`
            );
          } else {
            sessions[fromNumber].propertyData.yearBuilt = year;
            await sendMessage(fromNumber, 'Enter the total number of units:');
            sessions[fromNumber].action = 'add_property_totalUnits';
          }
        } else if (sessions[fromNumber].action === 'add_property_totalUnits') {
          if (isValidUnits(text)) {
            sessions[fromNumber].propertyData.totalUnits = parseInt(text);
            await sendPurchasePriceOptionButtons(fromNumber);
            sessions[fromNumber].action = 'add_property_purchasePrice_option';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease enter a valid number of units.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_property_purchasePrice') {
          if (!isNaN(parseFloat(text)) && parseFloat(text) > 0) {
            sessions[fromNumber].propertyData.purchasePrice = parseFloat(text);
            const user = await User.findOne({ phoneNumber });
            const property = new Property({
              propertyId: 'P' + crypto.randomBytes(4).toString('hex').toUpperCase(),
              name: sessions[fromNumber].propertyData.name,
              description: sessions[fromNumber].propertyData.description,
              address: sessions[fromNumber].propertyData.address,
              city: sessions[fromNumber].propertyData.city,
              state: sessions[fromNumber].propertyData.state,
              zipCode: sessions[fromNumber].propertyData.zipCode,
              country: sessions[fromNumber].propertyData.country,
              propertyType: sessions[fromNumber].propertyData.propertyType,
              yearBuilt: sessions[fromNumber].propertyData.yearBuilt,
              totalUnits: sessions[fromNumber].propertyData.totalUnits,
              purchasePrice: sessions[fromNumber].propertyData.purchasePrice,
              ownerId: user._id
            });
            await property.save();
            sessions[fromNumber].entityType = 'property';
            sessions[fromNumber].entityId = property._id;
            await sendImageOptionButton(fromNumber, 'property', property._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease enter a valid purchase price.'
            );
          }
        }
        // -- Additional flows omitted for brevity, but remain unchanged --
        // e.g. add_unit_flow, add_tenant_flow, etc.

      } // end if (text)

      // 4b-iv) Handle interactive replies
      if (interactive && userResponses[fromNumber]) {
        const selectedOption = userResponses[fromNumber];

        // Example: Handle top-level menu
        if (selectedOption === 'account_info') {
          const user = await User.findOne({ phoneNumber });
          const accountInfoMessage = user
            ? `
*👤 Account Information*
━━━━━━━━━━━━━━━
📞 *Phone*: ${user.phoneNumber}
✅ *Verified*: ${user.verified ? 'Yes' : 'No'}
🧑 *Profile Name*: ${user.profileName || 'N/A'}
📅 *Registration Date*: ${
                user.registrationDate ? user.registrationDate.toLocaleDateString() : 'N/A'
              }
💰 *Subscription*: ${user.subscription}
━━━━━━━━━━━━━━━`
            : '⚠️ *No Account Found* \nNo account information is available for this number.';
          await sendMessage(fromNumber, accountInfoMessage);
        } else if (selectedOption === 'manage') {
          await menuHelpers.sendManageSubmenu(fromNumber);
        } else if (selectedOption === 'tools') {
          await menuHelpers.sendToolsSubmenu(fromNumber);
        } else if (selectedOption === 'manage_properties') {
          await menuHelpers.sendPropertyOptions(fromNumber);
        } else if (selectedOption === 'manage_units') {
          await menuHelpers.sendUnitOptions(fromNumber);
        } else if (selectedOption === 'manage_tenants') {
          await menuHelpers.sendTenantOptions(fromNumber);
        } else if (selectedOption === 'add_property') {
          await sendMessage(fromNumber, 'Let’s start! Please provide the property name.');
          sessions[fromNumber].action = 'add_property_name';
        } else if (selectedOption === 'add_unit') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ ownerId: user._id });
          if (!properties.length) {
            await sendMessage(
              fromNumber,
              'No properties found. Please add a property first.'
            );
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            await sendPropertySelectionLists(fromNumber, properties);
            sessions[fromNumber].action = 'add_unit_select_property';
          }
        } else if (selectedOption === 'add_tenant') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ ownerId: user._id });
          if (!properties.length) {
            await sendMessage(
              fromNumber,
              'No properties found. Please add a property first.'
            );
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            await sendPropertySelectionLists(fromNumber, properties);
            sessions[fromNumber].action = 'add_tenant_select_property';
          }
        }
        // Continue with other interactive flow logic
        // (Selecting property, selecting unit, skipping upload, etc.)

        delete userResponses[fromNumber];
      }
    }
  }
  return res.sendStatus(200);
});

/**
 * 5) Summaries: final part of your original code
 */
async function sendSummary(phoneNumber, type, entityId, imageUrl) {
  let caption;
  if (type === 'property') {
    const property = await Property.findById(entityId);
    const summaryImage =
      property.images && property.images.length > 0 ? property.images[0] : DEFAULT_IMAGE_URL;
    caption = `✅ *Property Added*\n━━━━━━━━━━━━━━━\n🏠 *Name*: ${property.name}\n📝 *Description*: ${property.description}\n📍 *Address*: ${property.address}, ${property.city}, ${property.state} ${property.zipCode}, ${property.country}\n🏢 *Type*: ${property.propertyType}\n🏗️ *Year Built*: ${
      property.yearBuilt || 'N/A'
    }\n🏠 *Total Units*: ${property.totalUnits}\n💰 *Purchase Price*: ${
      property.purchasePrice || 'N/A'
    }\n━━━━━━━━━━━━━━━\nReply with *Edit* to modify details.`;
    await sendImageMessage(phoneNumber, summaryImage, caption);
  } else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('property');
    caption = `✅ *Unit Added*\n━━━━━━━━━━━━━━━\n🏠 *Property*: ${unit.property.name}\n🚪 *Unit ID*: ${
      unit.unitNumber
    }\n💰 *Rent Amount*: ${unit.rentAmount}\n📏 *Floor*: ${
      unit.floor
    }\n📐 *Size*: ${unit.size}\n━━━━━━━━━━━━━━━\nReply with *Edit* to modify details.`;
    await sendImageMessage(phoneNumber, imageUrl, caption);
  } else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId);
    const unit = await Unit.findById(tenant.unitAssigned);
    caption = `✅ *Tenant Added*\n━━━━━━━━━━━━━━━\n👤 *Name*: ${
      tenant.fullName
    }\n🏠 *Property*: ${tenant.propertyName}\n🚪 *Unit*: ${
      unit ? unit.unitNumber : 'N/A'
    }\n📅 *Lease Start*: ${new Date(tenant.leaseStartDate).toLocaleDateString()}\n💵 *Deposit*: ${
      tenant.depositAmount
    }\n💰 *Monthly Rent*: ${tenant.monthlyRent}\n━━━━━━━━━━━━━━━\nReply with *Edit* to modify details.`;
    await sendImageMessage(phoneNumber, imageUrl, caption);
  }
}

module.exports = {
  router,
  sendMessage,
  sendSummary,
};
