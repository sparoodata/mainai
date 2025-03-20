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

// Check if string is numeric.
function isNumeric(value) {
  return /^\d+$/.test(value);
}

// Generate unique property ID.
function generatePropertyId() {
  return 'P' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

/*
  Enterprise-style interactive menus:
*/

/* Country selection (only India) */
async function sendCountrySelectionList(fromNumber) {
  const rows = [{
    id: 'country_India',
    title: 'India',
    description: 'Select India'
  }];
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'Enterprise Rental Portal - Country Selection' },
      body: { text: 'Please select your country for property registration:' },
      footer: { text: '© Enterprise Rental Management' },
      action: {
        button: 'Select Country',
        sections: [{ title: 'Country', rows }]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, messageData, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

/* Property type selection */
async function sendPropertyTypeButtons(fromNumber) {
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Enterprise Rental Portal - Property Type' },
      body: { text: 'Select the type of property:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'ptype_Apartment', title: 'Apartment' } },
          { type: 'reply', reply: { id: 'ptype_Independant', title: 'Independent House' } },
          { type: 'reply', reply: { id: 'ptype_Others', title: 'Others' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, messageData, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

/* Year built option */
async function sendYearBuiltOptionButtons(fromNumber) {
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Optional: Year Built' },
      body: { text: 'Would you like to provide the construction year?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'year_enter', title: 'Enter Year' } },
          { type: 'reply', reply: { id: 'year_skip', title: 'Skip' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, messageData, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

/* Purchase price option */
async function sendPurchasePriceOptionButtons(fromNumber) {
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Optional: Purchase Price' },
      body: { text: 'Would you like to provide the purchase price?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'price_enter', title: 'Enter Price' } },
          { type: 'reply', reply: { id: 'price_skip', title: 'Skip' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, messageData, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

/* Property selection interactive list */
async function sendPropertySelectionLists(fromNumber, properties) {
  const chunks = chunkArray(properties, 10);
  for (let i = 0; i < chunks.length; i++) {
    const rows = chunks[i].map(prop => ({
      id: `prop_${prop._id}`,
      title: prop.name,
      description: prop.address || ''
    }));
    const headerText = i === 0 ? 'Enterprise Rental Portal - Select Property' : `Property List #${i + 1}`;
    const bodyText = i === 0 ? 'Choose a property to manage:' : 'More properties:';
    const footerText = i === 0 ? '© Enterprise Rental Management' : '';
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
    await axios.post(WHATSAPP_API_URL, messageData, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
  }
}

/* Unit selection interactive list */
async function sendUnitSelectionLists(fromNumber, units) {
  const chunks = chunkArray(units, 10);
  for (let i = 0; i < chunks.length; i++) {
    const rows = chunks[i].map(unit => ({
      id: `unit_${unit._id}`,
      title: unit.unitNumber,
      description: `Floor: ${unit.floor}`
    }));
    const headerText = i === 0 ? 'Enterprise Rental Portal - Select Unit' : `Unit List #${i + 1}`;
    const bodyText = i === 0 ? 'Choose a unit to manage:' : 'More units:';
    const footerText = i === 0 ? '© Enterprise Rental Management' : '';
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
    await axios.post(WHATSAPP_API_URL, messageData, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
  }
}

/* Image upload option button */
async function sendImageOptionButton(fromNumber, type, entityId) {
  const token = await generateUploadToken(fromNumber, type, entityId);
  const imageUploadUrl = `${GLITCH_HOST}/upload-image/${fromNumber}/${type}/${entityId}?token=${token}`;
  const shortUrl = await shortenUrl(imageUploadUrl);
  await sendMessage(fromNumber, `Kindly upload the image using this secure link (valid for 15 minutes): ${shortUrl}`);
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Image Upload Option' },
      body: { text: 'If you prefer to skip the image upload, select below:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `no_upload_${type}_${entityId}`, title: 'Skip Image' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, messageData, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

/* ----------------- Webhook Endpoints ----------------- */

// GET for webhook verification
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

// Main webhook POST handler
router.post('/', async (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    // Update or save user profile
    if (value.contacts) {
      const contact = value.contacts[0];
      const contactPhoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile.name;
      const user = (await User.findOne({ phoneNumber: contactPhoneNumber })) ||
                   new User({ phoneNumber: contactPhoneNumber });
      user.profileName = profileName || user.profileName;
      await user.save();
    }

    // Process incoming messages
    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;
      const phoneNumber = `+${fromNumber}`;
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;
      console.log(`Message from ${fromNumber}:`, { text, interactive });
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
      if (text) {
        // Help command returns a professional main menu
        if (text.toLowerCase() === 'help') {
          const buttonMenu = {
            messaging_product: 'whatsapp',
            to: fromNumber,
            type: 'interactive',
            interactive: {
              type: 'button',
              header: { type: 'text', text: 'Enterprise Rental Portal' },
              body: { text: 'Welcome to the Enterprise Rental Management System. Please select an option:' },
              footer: { text: '© Enterprise Rental Management' },
              action: {
                buttons: [
                  { type: 'reply', reply: { id: 'account_info', title: 'Account Info' } },
                  { type: 'reply', reply: { id: 'manage_properties', title: 'Properties' } },
                  { type: 'reply', reply: { id: 'manage_units', title: 'Units' } },
                  { type: 'reply', reply: { id: 'manage_tenants', title: 'Tenants' } },
                  { type: 'reply', reply: { id: 'tools', title: 'Tools' } }
                ]
              }
            }
          };
          await axios.post(WHATSAPP_API_URL, buttonMenu, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
          return res.sendStatus(200);
        }
        // Enterprise-style property creation flow
        if (sessions[fromNumber].action === 'add_property_name') {
          if (isValidName(text)) {
            sessions[fromNumber].propertyData = { name: text };
            await sendMessage(fromNumber, 'Please provide a concise property description (max 100 characters).');
            sessions[fromNumber].action = 'add_property_description';
          } else {
            await sendMessage(fromNumber, 'Invalid property name. Please try again.');
          }
        } else if (sessions[fromNumber].action === 'add_property_description') {
          if (text.length > 100) {
            await sendMessage(fromNumber, 'Description exceeds 100 characters. Please enter a shorter description.');
            return res.sendStatus(200);
          }
          sessions[fromNumber].propertyData.description = text;
          await sendMessage(fromNumber, 'Enter the street address:');
          sessions[fromNumber].action = 'add_property_address';
        } else if (sessions[fromNumber].action === 'add_property_address') {
          if (isValidAddress(text)) {
            sessions[fromNumber].propertyData.address = text;
            await sendMessage(fromNumber, 'Enter the city:');
            sessions[fromNumber].action = 'add_property_city';
          } else {
            await sendMessage(fromNumber, 'Invalid address. Please re-enter.');
          }
        } else if (sessions[fromNumber].action === 'add_property_city') {
          sessions[fromNumber].propertyData.city = text;
          await sendMessage(fromNumber, 'Enter the state:');
          sessions[fromNumber].action = 'add_property_state';
        } else if (sessions[fromNumber].action === 'add_property_state') {
          sessions[fromNumber].propertyData.state = text;
          await sendMessage(fromNumber, 'Enter the ZIP code (numbers only):');
          sessions[fromNumber].action = 'add_property_zip';
        } else if (sessions[fromNumber].action === 'add_property_zip') {
          if (!isNumeric(text)) {
            await sendMessage(fromNumber, 'ZIP code must contain only numbers. Please re-enter:');
            return res.sendStatus(200);
          }
          sessions[fromNumber].propertyData.zipCode = text;
          await sendCountrySelectionList(fromNumber);
          sessions[fromNumber].action = 'awaiting_property_country';
        } else if (sessions[fromNumber].action === 'awaiting_property_country') {
          // Handled via interactive reply.
        } else if (sessions[fromNumber].action === 'awaiting_property_type') {
          // Handled via interactive reply.
        } else if (sessions[fromNumber].action === 'add_property_yearBuilt') {
          const year = parseInt(text);
          if (!isNaN(year)) {
            sessions[fromNumber].propertyData.yearBuilt = year;
            await sendMessage(fromNumber, 'Enter the total number of units:');
            sessions[fromNumber].action = 'add_property_totalUnits';
          } else {
            await sendMessage(fromNumber, 'Invalid year. Please re-enter.');
          }
        } else if (sessions[fromNumber].action === 'add_property_totalUnits') {
          if (isValidUnits(text)) {
            sessions[fromNumber].propertyData.totalUnits = parseInt(text);
            await sendPurchasePriceOptionButtons(fromNumber);
            sessions[fromNumber].action = 'add_property_purchasePrice_option';
          } else {
            await sendMessage(fromNumber, 'Invalid unit number. Please re-enter.');
          }
        } else if (sessions[fromNumber].action === 'add_property_purchasePrice') {
          if (!isNaN(parseFloat(text)) && parseFloat(text) > 0) {
            sessions[fromNumber].propertyData.purchasePrice = parseFloat(text);
            const user = await User.findOne({ phoneNumber });
            const property = new Property({
              propertyId: generatePropertyId(),
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
              ownerId: user._id,
            });
            await property.save();
            sessions[fromNumber].entityType = 'property';
            sessions[fromNumber].entityId = property._id;
            await sendImageOptionButton(fromNumber, 'property', property._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
          } else {
            await sendMessage(fromNumber, 'Invalid purchase price. Please re-enter.');
          }
        }
        // (Add-Unit and Tenant flows can follow similar enterprise-style language.)
      }
      // Process interactive replies (enterprise-style menus)
      if (interactive && userResponses[fromNumber]) {
        const selectedOption = userResponses[fromNumber];
        if (selectedOption === 'account_info') {
          const user = await User.findOne({ phoneNumber });
          const accountInfoMessage = user
            ? `
*Enterprise Account Information*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 Phone: ${user.phoneNumber}
✅ Verified: ${user.verified ? 'Yes' : 'No'}
🧑 Profile: ${user.profileName || 'N/A'}
📅 Registered: ${user.registrationDate ? user.registrationDate.toLocaleDateString() : 'N/A'}
💰 Subscription: ${user.subscription}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
            : 'No account information available.';
          await sendMessage(fromNumber, accountInfoMessage);
        } else if (selectedOption === 'manage_properties') {
          await menuHelpers.sendPropertyOptions(fromNumber);
        } else if (selectedOption === 'manage_units') {
          await menuHelpers.sendUnitOptions(fromNumber);
        } else if (selectedOption === 'manage_tenants') {
          await menuHelpers.sendTenantOptions(fromNumber);
        } else if (selectedOption === 'add_property') {
          await sendMessage(fromNumber, 'Enterprise Rental Portal: Please provide the property name:');
          sessions[fromNumber].action = 'add_property_name';
        } else if (selectedOption === 'add_unit') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ ownerId: user._id });
          if (!properties.length) {
            await sendMessage(fromNumber, 'No properties found. Please register a property first.');
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
            await sendMessage(fromNumber, 'No properties found. Please register a property first.');
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            await sendPropertySelectionLists(fromNumber, properties);
            sessions[fromNumber].action = 'add_tenant_select_property';
          }
        }
        // ... Additional interactive reply handling for sub-menus ...
        // --- Image Upload Choice ---
        else if (sessions[fromNumber].action === 'awaiting_image_choice') {
          if (selectedOption.startsWith('upload_')) {
            const [, type, entityId] = selectedOption.split('_');
            const token = await generateUploadToken(phoneNumber, type, entityId);
            const imageUploadUrl = `${GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${entityId}?token=${token}`;
            const shortUrl = await shortenUrl(imageUploadUrl);
            await sendMessage(fromNumber, `Please upload your image using this secure link (valid for 15 minutes): ${shortUrl}`);
            sessions[fromNumber] = {};
          } else if (selectedOption.startsWith('no_upload_')) {
            const [, type, entityId] = selectedOption.split('_');
            if (type === 'property') {
              const property = await Property.findById(entityId);
              property.images.push(DEFAULT_IMAGE_URL);
              await property.save();
              if (!sessions[fromNumber].summarySent) {
                sessions[fromNumber].summarySent = true;
                await sendSummary(fromNumber, 'property', entityId, DEFAULT_IMAGE_URL);
              }
            } else if (type === 'unit') {
              const unit = await Unit.findById(entityId);
              unit.images.push(DEFAULT_IMAGE_URL);
              await unit.save();
              if (!sessions[fromNumber].summarySent) {
                sessions[fromNumber].summarySent = true;
                await sendSummary(fromNumber, 'unit', entityId, DEFAULT_IMAGE_URL);
              }
            } else if (type === 'tenant') {
              const tenant = await Tenant.findById(entityId);
              tenant.photo = DEFAULT_IMAGE_URL;
              await tenant.save();
              if (!sessions[fromNumber].summarySent) {
                sessions[fromNumber].summarySent = true;
                await sendSummary(fromNumber, 'tenant', entityId, DEFAULT_IMAGE_URL);
              }
            }
            sessions[fromNumber] = {};
          }
        }
        delete userResponses[fromNumber];
      }
    }
  }
  res.sendStatus(200);
});

// Summary function: Sends one professional image message with caption.
async function sendSummary(phoneNumber, type, entityId, imageUrl) {
  let caption;
  if (type === 'property') {
    const property = await Property.findById(entityId);
    const summaryImage = (property.images && property.images.length > 0) ? property.images[0] : DEFAULT_IMAGE_URL;
    caption = `✅ *Property Successfully Registered*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏠 Name: ${property.name}\n📝 Description: ${property.description}\n📍 Address: ${property.address}, ${property.city}, ${property.state} ${property.zipCode}, ${property.country}\n🏢 Type: ${property.propertyType}\n🏗️ Year Built: ${property.yearBuilt || 'N/A'}\n🏠 Total Units: ${property.totalUnits}\n💰 Purchase Price: ${property.purchasePrice || 'N/A'}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    await sendImageMessage(phoneNumber, summaryImage, caption);
  } else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('property');
    caption = `✅ *Unit Registered*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏠 Property: ${unit.property.name}\n🚪 Unit ID: ${unit.unitNumber}\n💰 Rent: ${unit.rentAmount}\n📏 Floor: ${unit.floor}\n📐 Size: ${unit.size}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    await sendImageMessage(phoneNumber, imageUrl, caption);
  } else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId);
    const unit = await Unit.findById(tenant.unitAssigned);
    caption = `✅ *Tenant Registered*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 Name: ${tenant.fullName}\n🏠 Property: ${tenant.propertyName}\n🚪 Unit: ${unit ? unit.unitNumber : 'N/A'}\n📅 Lease Start: ${new Date(tenant.leaseStartDate).toLocaleDateString()}\n💵 Deposit: ${tenant.depositAmount}\n💰 Monthly Rent: ${tenant.monthlyRent}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    await sendImageMessage(phoneNumber, imageUrl, caption);
  }
}

module.exports = {
  router,
  sendMessage,
  sendSummary,
};
