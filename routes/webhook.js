/**
 * webhook.js
 * Updated: Forward payload changes to Groq endpoint
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');

// Import helper functions and models
const { chunkArray, isValidName, isValidAddress, isNumeric, isValidUnits } = require('../helpers/validators');
const menuHelpers = require('../helpers/menuHelpers');
const { generateUploadToken } = require('../helpers/uploadToken');
const { shortenUrl } = require('../helpers/shortenUrl');
const User = require('../models/User');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Tenant = require('../models/Tenant');

// WhatsApp API and other constants (assumed to be set in config or env variables)
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;
const DEFAULT_IMAGE_URL = process.env.DEFAULT_IMAGE_URL || 'https://via.placeholder.com/150';

// In-memory storage for sessions and user responses
const sessions = {};
const userResponses = {};

// Function to send a simple text message via WhatsApp
async function sendMessage(to, message) {
  const messageData = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: message }
  };
  try {
    await axios.post(WHATSAPP_API_URL, messageData, {
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error sending message:', error);
  }
}

// Function to send an image message via WhatsApp
async function sendImageMessage(to, imageUrl, caption) {
  const messageData = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link: imageUrl, caption }
  };
  try {
    await axios.post(WHATSAPP_API_URL, messageData, {
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error sending image message:', error);
  }
}

// Send interactive buttons for Year Built option
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
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// Send interactive buttons for Purchase Price option
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
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// Send an interactive list for property selection
async function sendPropertySelectionLists(fromNumber, properties) {
  const chunks = chunkArray(properties, 10);
  for (let i = 0; i < chunks.length; i++) {
    const rows = chunks[i].map((prop) => ({
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
        action: { button: actionButton, sections: [{ title: 'Properties', rows }] }
      }
    };
    await axios.post(WHATSAPP_API_URL, messageData, {
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
    });
  }
}

// Send an interactive list for unit selection
async function sendUnitSelectionLists(fromNumber, units) {
  const chunks = chunkArray(units, 10);
  for (let i = 0; i < chunks.length; i++) {
    const rows = chunks[i].map((unit) => ({
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
        action: { button: actionButton, sections: [{ title: 'Units', rows }] }
      }
    };
    await axios.post(WHATSAPP_API_URL, messageData, {
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
    });
  }
}

// Send an interactive button to upload or skip an image
async function sendImageOptionButton(fromNumber, type, entityId) {
  const token = await generateUploadToken(fromNumber, type, entityId);
  const imageUploadUrl = `${GLITCH_HOST}/upload-image/${fromNumber}/${type}/${entityId}?token=${token}`;
  const shortUrl = await shortenUrl(imageUploadUrl);

  await sendMessage(
    fromNumber,
    `Please upload the image here (valid for 15 minutes): ${shortUrl}`
  );

  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '' },
      body: {
        text: 'If you wish to skip uploading an image, tap the button below:'
      },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: `no_upload_${type}_${entityId}`, title: 'No, Skip' }
          }
        ]
      }
    }
  };

  await axios.post(WHATSAPP_API_URL, messageData, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

/**
 * forwardToGroq - Forwards slash commands (starting with "/") to the Groq endpoint.
 * 
 * NOTE: We now explicitly stringify the JSON payload and log it before sending.
 */
async function forwardToGroq(phoneNumber, message) {
  try {
    // Build payload with keys at the root level
    const payload = { phoneNumber, message };
    console.log('Forwarding payload to Groq:', payload);
    const response = await axios.post(
      'https://defiant-stone-tail.glitch.me/groq',
      JSON.stringify(payload),
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error forwarding to Groq:', error);
    return 'There was an error processing your request.';
  }
}

/**
 * GET /webhook - Verification Endpoint
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
  return res.sendStatus(403);
});

/**
 * POST /webhook - Main Handler for Incoming WhatsApp Messages
 */
router.post('/', async (req, res) => {
  const body = req.body;

  // Confirm it's a WhatsApp Business Account update
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

    // 4b) Process any incoming messages
    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;
      const phoneNumber = `+${fromNumber}`;
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      console.log(`Message from ${fromNumber}:`, { text, interactive });

      /**
       * 4b-i) If the message begins with '/', forward to Groq
       */
      if (text && text.startsWith('/')) {
        const groqReply = await forwardToGroq(phoneNumber, text);
        await sendMessage(fromNumber, groqReply);
        return res.sendStatus(200);
      }

      // 4b-ii) For interactive messages, record the selected option
      if (interactive && interactive.type === 'list_reply') {
        userResponses[fromNumber] = interactive.list_reply.id;
        console.log(`List reply received: ${userResponses[fromNumber]}`);
      } else if (interactive && interactive.type === 'button_reply') {
        userResponses[fromNumber] = interactive.button_reply.id;
        console.log(`Button reply received: ${userResponses[fromNumber]}`);
      }

      // Initialize a session if none exists
      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      // 4b-iii) If it's a normal text message (not slash), continue the flows
      if (text) {
        // Example: handle 'help'
        if (text.toLowerCase() === 'help') {
          if (sessions[fromNumber].action === 'awaiting_image_choice') {
            // If the user is in the middle of uploading an image, ignore "help"
            return res.sendStatus(200);
          }
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

        /**
         * Example property creation flow (as in your original code).
         */
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
          // Assume sendCountrySelectionList sends a list of countries for selection
          await sendMessage(fromNumber, 'Select the country from the list.');
          sessions[fromNumber].action = 'awaiting_property_country';
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
        // ...Continue other flows as needed...
      }

      /**
       * 4b-iv) Handle interactive replies from the user
       */
      if (interactive && userResponses[fromNumber]) {
        const selectedOption = userResponses[fromNumber];

        // Example top-level menu: account_info
        if (selectedOption === 'account_info') {
          const user = await User.findOne({ phoneNumber });
          const accountInfoMessage = user
            ? `
*👤 Account Information*
━━━━━━━━━━━━━━━
📞 *Phone*: ${user.phoneNumber}
✅ *Verified*: ${user.verified ? 'Yes' : 'No'}
🧑 *Profile Name*: ${user.profileName || 'N/A'}
📅 *Registration Date*: ${user.registrationDate ? user.registrationDate.toLocaleDateString() : 'N/A'}
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
            await sendMessage(fromNumber, 'No properties found. Please add a property first.');
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
            await sendMessage(fromNumber, 'No properties found. Please add a property first.');
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            await sendPropertySelectionLists(fromNumber, properties);
            sessions[fromNumber].action = 'add_tenant_select_property';
          }
        }

        // ...More interactive flow handling...
        delete userResponses[fromNumber];
      }
    }
  }
  return res.sendStatus(200);
});

/**
 * sendSummary - Sends a summary message (with an image) after adding an entity.
 */
async function sendSummary(phoneNumber, type, entityId, imageUrl) {
  let caption;
  if (type === 'property') {
    const property = await Property.findById(entityId);
    const summaryImage = property.images && property.images.length > 0 ? property.images[0] : DEFAULT_IMAGE_URL;
    caption = `✅ *Property Added*\n━━━━━━━━━━━━━━━\n🏠 *Name*: ${property.name}\n📝 *Description*: ${property.description}\n📍 *Address*: ${property.address}, ${property.city}, ${property.state} ${property.zipCode}, ${property.country}\n🏢 *Type*: ${property.propertyType}\n🏗️ *Year Built*: ${property.yearBuilt || 'N/A'}\n🏠 *Total Units*: ${property.totalUnits}\n💰 *Purchase Price*: ${property.purchasePrice || 'N/A'}\n━━━━━━━━━━━━━━━\nReply with *Edit* to modify details.`;
    await sendImageMessage(phoneNumber, summaryImage, caption);
  } else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('property');
    caption = `✅ *Unit Added*\n━━━━━━━━━━━━━━━\n🏠 *Property*: ${unit.property.name}\n🚪 *Unit ID*: ${unit.unitNumber}\n💰 *Rent Amount*: ${unit.rentAmount}\n📏 *Floor*: ${unit.floor}\n📐 *Size*: ${unit.size}\n━━━━━━━━━━━━━━━\nReply with *Edit* to modify details.`;
    await sendImageMessage(phoneNumber, imageUrl, caption);
  } else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId);
    const unit = await Unit.findById(tenant.unitAssigned);
    caption = `✅ *Tenant Added*\n━━━━━━━━━━━━━━━\n👤 *Name*: ${tenant.fullName}\n🏠 *Property*: ${tenant.propertyName}\n🚪 *Unit*: ${unit ? unit.unitNumber : 'N/A'}\n📅 *Lease Start*: ${new Date(tenant.leaseStartDate).toLocaleDateString()}\n💵 *Deposit*: ${tenant.depositAmount}\n💰 *Monthly Rent*: ${tenant.monthlyRent}\n━━━━━━━━━━━━━━━\nReply with *Edit* to modify details.`;
    await sendImageMessage(phoneNumber, imageUrl, caption);
  }
}

module.exports = {
  router,
  sendMessage,
  sendSummary
};
