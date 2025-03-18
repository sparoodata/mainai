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
  return /^-?\d+$/.test(value);
}

// NEW HELPER: Generate a unique property ID.
function generatePropertyId() {
  return 'P' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

/*
  Helper: Send an interactive list for country selection (only "India").
*/
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
      header: { type: 'text', text: '🌏 Select Country' },
      body: { text: 'Please select your country:' },
      footer: { text: 'Powered by Your Rental App' },
      action: {
        button: 'View Country',
        sections: [
          { title: 'Country', rows: rows }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, messageData, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

/*
  Helper: Send interactive buttons for property type selection.
*/
async function sendPropertyTypeButtons(fromNumber) {
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Select Property Type' },
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
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

/*
  Helper: Send interactive buttons for Year Built option.
*/
async function sendYearBuiltOptionButtons(fromNumber) {
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Year Built (Optional)' },
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

/*
  Helper: Send interactive buttons for Purchase Price option.
*/
async function sendPurchasePriceOptionButtons(fromNumber) {
  const messageData = {
    messaging_product: 'whatsapp',
    to: fromNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Purchase Price (Optional)' },
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

/*
  Helper: Send an interactive list for property selection.
  Splits properties into chunks of up to 10.
*/
async function sendPropertySelectionLists(fromNumber, properties) {
  const chunks = chunkArray(properties, 10);
  for (let i = 0; i < chunks.length; i++) {
    const rows = chunks[i].map(prop => ({
      id: `prop_${prop._id}`,
      title: prop.name,
      description: prop.address || ''
    }));
    const headerText = i === 0 ? '🏠 Select a Property' : `Property list #${i + 1}`;
    const bodyText = i === 0 ? 'Please select a property from the list below:' : 'Select a property:';
    const footerText = i === 0 ? 'Powered by Your Rental App' : '';
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
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
    });
  }
}

/*
  Helper: Send an interactive list for unit selection.
  Splits units into chunks of up to 10.
*/
async function sendUnitSelectionLists(fromNumber, units) {
  const chunks = chunkArray(units, 10);
  for (let i = 0; i < chunks.length; i++) {
    const rows = chunks[i].map(unit => ({
      id: `unit_${unit._id}`,
      title: unit.unitNumber,
      description: `Floor: ${unit.floor}`
    }));
    const headerText = i === 0 ? '🚪 Select a Unit' : `Unit list #${i + 1}`;
    const bodyText = i === 0 ? 'Please select a unit from the list below:' : 'Select a unit:';
    const footerText = i === 0 ? 'Powered by Your Rental App' : '';
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
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
    });
  }
}

/*
  Helper: Send image upload option.
  First sends a clickable tinyURL link as text, then sends an interactive message with a skip button.
*/
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
      header: { type: 'text', text: 'Image Upload Option' },
      body: { text: 'If you wish to skip uploading an image, tap the button below:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `no_upload_${type}_${entityId}`, title: 'No, Skip' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, messageData, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

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
    if (value.contacts) {
      const contact = value.contacts[0];
      const contactPhoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile.name;
      const user = (await User.findOne({ phoneNumber: contactPhoneNumber })) ||
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
            headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
          });
          return res.sendStatus(200);
        }
        // --- Property Creation Flow ---
        if (sessions[fromNumber].action === 'add_property_name') {
          if (isValidName(text)) {
            sessions[fromNumber].propertyData = { name: text };
            await sendMessage(fromNumber, '📝 *Description* \nPlease provide a description for the property (max 100 characters).');
            sessions[fromNumber].action = 'add_property_description';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease retry with a valid property name.');
          }
        } else if (sessions[fromNumber].action === 'add_property_description') {
          // Validate description length
          if (text.length > 100) {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nProperty description must not exceed 100 characters. Please re-enter:');
            return res.sendStatus(200);
          }
          sessions[fromNumber].propertyData.description = text;
          await sendMessage(fromNumber, '📍 *Street Address* \nPlease provide the street address of the property.');
          sessions[fromNumber].action = 'add_property_address';
        } else if (sessions[fromNumber].action === 'add_property_address') {
          if (isValidAddress(text)) {
            sessions[fromNumber].propertyData.address = text;
            await sendMessage(fromNumber, '🏙️ *City* \nEnter the city.');
            sessions[fromNumber].action = 'add_property_city';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease retry with a valid street address.');
          }
        } else if (sessions[fromNumber].action === 'add_property_city') {
          sessions[fromNumber].propertyData.city = text;
          await sendMessage(fromNumber, '🌆 *State* \nEnter the state.');
          sessions[fromNumber].action = 'add_property_state';
        } else if (sessions[fromNumber].action === 'add_property_state') {
          sessions[fromNumber].propertyData.state = text;
          await sendMessage(fromNumber, '📮 *ZIP Code* \nEnter the ZIP code.');
          sessions[fromNumber].action = 'add_property_zip';
        } else if (sessions[fromNumber].action === 'add_property_zip') {
          sessions[fromNumber].propertyData.zipCode = text;
          await sendCountrySelectionList(fromNumber);
          sessions[fromNumber].action = 'awaiting_property_country';
        } else if (sessions[fromNumber].action === 'awaiting_property_country') {
          // Handled via interactive reply below.
        } else if (sessions[fromNumber].action === 'awaiting_property_type') {
          // Handled via interactive reply below.
        } else if (sessions[fromNumber].action === 'add_property_yearBuilt') {
          const year = parseInt(text);
          if (!isNaN(year)) {
            sessions[fromNumber].propertyData.yearBuilt = year;
            await sendMessage(fromNumber, '🏠 *Total Units* \nEnter the total number of units.');
            sessions[fromNumber].action = 'add_property_totalUnits';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease enter a valid year.');
          }
        } else if (sessions[fromNumber].action === 'add_property_totalUnits') {
          if (isValidUnits(text)) {
            sessions[fromNumber].propertyData.totalUnits = parseInt(text);
            await sendPurchasePriceOptionButtons(fromNumber);
            sessions[fromNumber].action = 'add_property_purchasePrice_option';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease enter a valid number of units.');
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
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease enter a valid purchase price.');
          }
        }
        // --- Add-Unit Flow ---
        else if (sessions[fromNumber].action === 'add_unit_rent') {
          const rent = parseFloat(text);
          if (!isNaN(rent) && rent > 0) {
            sessions[fromNumber].unitData.rentAmount = rent;
            await sendMessage(fromNumber, '📏 *Floor* \nWhich floor is this unit on? (e.g., 1, Ground)');
            sessions[fromNumber].action = 'add_unit_floor';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease provide a valid rent amount.');
          }
        } else if (sessions[fromNumber].action === 'add_unit_floor') {
          sessions[fromNumber].unitData.floor = text;
          await sendMessage(fromNumber, '📐 *Size* \nWhat is the size of this unit (e.g., 500 sq ft)?');
          sessions[fromNumber].action = 'add_unit_size';
        } else if (sessions[fromNumber].action === 'add_unit_size') {
          const user = await User.findOne({ phoneNumber });
          const generatedUnitId = sessions[fromNumber].unitData.unitNumber;
          const unit = new Unit({
            unitId: generatedUnitId,
            property: sessions[fromNumber].unitData.property,
            unitNumber: generatedUnitId,
            rentAmount: sessions[fromNumber].unitData.rentAmount,
            floor: sessions[fromNumber].unitData.floor,
            size: text,
            userId: user._id,
          });
          await unit.save();
          sessions[fromNumber].entityType = 'unit';
          sessions[fromNumber].entityId = unit._id;
          await sendImageOptionButton(fromNumber, 'unit', unit._id);
          sessions[fromNumber].action = 'awaiting_image_choice';
        }
        // --- Extended Add-Tenant Flow ---
        else if (sessions[fromNumber].action === 'add_tenant_fullName') {
          if (!sessions[fromNumber].tenantData) sessions[fromNumber].tenantData = {};
          sessions[fromNumber].tenantData.fullName = text;
          await sendMessage(fromNumber, '📅 *Lease Start Date* \nWhen does the lease start? (e.g., DD-MM-YYYY)');
          sessions[fromNumber].action = 'add_tenant_leaseStartDate';
        } else if (sessions[fromNumber].action === 'add_tenant_leaseStartDate') {
          if (isValidDate(text)) {
            sessions[fromNumber].tenantData.leaseStartDate = text;
            await sendMessage(fromNumber, '💵 *Deposit Amount* \nWhat is the deposit amount?');
            sessions[fromNumber].action = 'add_tenant_depositAmount';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Date* \nPlease use DD-MM-YYYY format (e.g., 01-01-2025).');
          }
        } else if (sessions[fromNumber].action === 'add_tenant_depositAmount') {
          const deposit = parseFloat(text);
          if (!isNaN(deposit) && deposit > 0) {
            sessions[fromNumber].tenantData.depositAmount = deposit;
            await sendMessage(fromNumber, '💰 *Monthly Rent* \nWhat is the monthly rent amount?');
            sessions[fromNumber].action = 'add_tenant_monthlyRent';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease provide a valid deposit amount.');
          }
        } else if (sessions[fromNumber].action === 'add_tenant_monthlyRent') {
          const rent = parseFloat(text);
          if (!isNaN(rent) && rent > 0) {
            if (!sessions[fromNumber].tenantData.unitAssigned) {
              await sendMessage(fromNumber, '⚠️ *Error:* Unit not selected. Please select a valid unit for the tenant.');
              sessions[fromNumber].action = 'add_tenant_select_unit';
              return res.sendStatus(200);
            }
            const user = await User.findOne({ phoneNumber });
            const tenant = new Tenant({
              fullName: sessions[fromNumber].tenantData.fullName,
              phoneNumber: user.phoneNumber,
              userId: user._id,
              propertyName: sessions[fromNumber].tenantData.propertyName,
              unitAssigned: sessions[fromNumber].tenantData.unitAssigned,
              leaseStartDate: sessions[fromNumber].tenantData.leaseStartDate,
              depositAmount: sessions[fromNumber].tenantData.depositAmount,
              monthlyRent: rent,
              tenantId: generateTenantId(),
            });
            await tenant.save();
            sessions[fromNumber].entityType = 'tenant';
            sessions[fromNumber].entityId = tenant._id;
            sessions[fromNumber].summarySent = false;
            await sendImageOptionButton(fromNumber, 'tenant', tenant._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease provide a valid monthly rent amount.');
          }
        }
      }
      // Process interactive replies
      if (interactive && userResponses[fromNumber]) {
        const selectedOption = userResponses[fromNumber];
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
          await sendMessage(fromNumber, '🏠 *Add Property* \nLet’s start! Please provide the property name.');
          sessions[fromNumber].action = 'add_property_name';
        } else if (selectedOption === 'add_unit') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ ownerId: user._id });
          if (!properties.length) {
            await sendMessage(fromNumber, 'ℹ️ *No Properties* \nPlease add a property first.');
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
            await sendMessage(fromNumber, 'ℹ️ *No Properties* \nPlease add a property first.');
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            await sendPropertySelectionLists(fromNumber, properties);
            sessions[fromNumber].action = 'add_tenant_select_property';
          }
        }
        // Property selection for Unit creation (list reply)
        else if (sessions[fromNumber].action === 'add_unit_select_property') {
          if (selectedOption.startsWith('prop_')) {
            const propertyId = selectedOption.split('_')[1];
            const foundProperty = await Property.findById(propertyId);
            if (foundProperty) {
              sessions[fromNumber].unitData = { property: foundProperty._id };
              sessions[fromNumber].unitData.unitNumber = generateUnitId();
              await sendMessage(fromNumber, `Unit ID generated: ${sessions[fromNumber].unitData.unitNumber}. Please provide the rent amount for this unit.`);
              sessions[fromNumber].action = 'add_unit_rent';
            } else {
              await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease select a valid property.');
            }
          }
        }
        // Property selection for Tenant creation (list reply)
        else if (sessions[fromNumber].action === 'add_tenant_select_property') {
          if (selectedOption.startsWith('prop_')) {
            const propertyId = selectedOption.split('_')[1];
            const foundProperty = await Property.findById(propertyId);
            if (foundProperty) {
              const unitCount = await Unit.countDocuments({ property: foundProperty._id });
              if (foundProperty.totalUnits && unitCount >= foundProperty.totalUnits) {
                await sendMessage(fromNumber, '⚠️ *Property Full* \nThis property is fully occupied. Please select a different property.');
                return res.sendStatus(200);
              }
              sessions[fromNumber].tenantData = {
                propertyId: foundProperty._id,
                propertyName: foundProperty.name,
              };
              const units = await Unit.find({ property: foundProperty._id });
              if (!units.length) {
                await sendMessage(fromNumber, 'ℹ️ *No Units* \nPlease add a unit to this property first.');
                sessions[fromNumber].action = null;
                delete sessions[fromNumber].tenantData;
              } else {
                await sendUnitSelectionLists(fromNumber, units);
                sessions[fromNumber].action = 'add_tenant_select_unit';
              }
            } else {
              await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease select a valid property.');
            }
          }
        }
        // Unit selection for Tenant creation (list reply)
        else if (sessions[fromNumber].action === 'add_tenant_select_unit') {
          if (selectedOption.startsWith('unit_')) {
            const unitId = selectedOption.split('_')[1];
            const foundUnit = await Unit.findById(unitId).populate('property');
            if (foundUnit) {
              sessions[fromNumber].tenantData.unitAssigned = foundUnit._id;
              sessions[fromNumber].tenantData.propertyName = foundUnit.property.name;
              await sendMessage(fromNumber, '👤 *Tenant Full Name* \nPlease provide the tenant’s full name.');
              sessions[fromNumber].action = 'add_tenant_fullName';
            } else {
              await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease select a valid unit.');
            }
          }
        }
        // New interactive reply handlers for property creation options:
        else if (sessions[fromNumber].action === 'awaiting_property_country') {
          if (selectedOption.startsWith('country_')) {
            sessions[fromNumber].propertyData.country = 'India';
            await sendPropertyTypeButtons(fromNumber);
            sessions[fromNumber].action = 'awaiting_property_type';
          }
        } else if (sessions[fromNumber].action === 'awaiting_property_type') {
          if (selectedOption.startsWith('ptype_')) {
            const typeVal = selectedOption.split('_')[1];
            sessions[fromNumber].propertyData.propertyType = (typeVal === 'Independant') ? 'Independant house' : typeVal;
            await sendYearBuiltOptionButtons(fromNumber);
            sessions[fromNumber].action = 'add_property_yearBuilt_option';
          }
        } else if (sessions[fromNumber].action === 'add_property_yearBuilt_option') {
          if (selectedOption === 'year_enter') {
            await sendMessage(fromNumber, 'Please enter the year the property was built:');
            sessions[fromNumber].action = 'add_property_yearBuilt';
          } else if (selectedOption === 'year_skip') {
            sessions[fromNumber].propertyData.yearBuilt = null;
            await sendMessage(fromNumber, 'Enter the total number of units:');
            sessions[fromNumber].action = 'add_property_totalUnits';
          }
        } else if (sessions[fromNumber].action === 'add_property_purchasePrice_option') {
          if (selectedOption === 'price_enter') {
            await sendMessage(fromNumber, 'Please enter the purchase price:');
            sessions[fromNumber].action = 'add_property_purchasePrice';
          } else if (selectedOption === 'price_skip') {
            sessions[fromNumber].propertyData.purchasePrice = null;
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
          }
        }
        // ----- Image Upload Choice -----
        else if (sessions[fromNumber].action === 'awaiting_image_choice') {
          if (selectedOption.startsWith('upload_')) {
            const [, type, entityId] = selectedOption.split('_');
            const token = await generateUploadToken(phoneNumber, type, entityId);
            const imageUploadUrl = `${GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${entityId}?token=${token}`;
            const shortUrl = await shortenUrl(imageUploadUrl);
            await sendMessage(fromNumber, `Please upload the image here (valid for 15 minutes): ${shortUrl}`);
            sessions[fromNumber] = {}; // Clear session completely to avoid duplicate summaries.
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
            sessions[fromNumber] = {}; // Clear session completely.
          }
        }
        delete userResponses[fromNumber];
      }
    }
  }
  res.sendStatus(200);
});

// Summary function: Sends a single message (image with caption) only.
async function sendSummary(phoneNumber, type, entityId, imageUrl) {
  let caption;
  if (type === 'property') {
    const property = await Property.findById(entityId);
    const summaryImage = (property.images && property.images.length > 0) ? property.images[0] : DEFAULT_IMAGE_URL;
    caption = `✅ *Property Added*\n━━━━━━━━━━━━━━━\n🏠 *Name*: ${property.name}\n📝 *Description*: ${property.description}\n📍 *Address*: ${property.address}, ${property.city}, ${property.state} ${property.zipCode}, ${property.country}\n🏢 *Type*: ${property.propertyType}\n🏗️ *Year Built*: ${property.yearBuilt || 'N/A'}\n🏠 *Total Units*: ${property.totalUnits}\n💰 *Purchase Price*: ${property.purchasePrice || 'N/A'}\n━━━━━━━━━━━━━━━`;
    await sendImageMessage(phoneNumber, summaryImage, caption);
  } else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('property');
    caption = `✅ *Unit Added*\n━━━━━━━━━━━━━━━\n🏠 *Property*: ${unit.property.name}\n🚪 *Unit ID*: ${unit.unitNumber}\n💰 *Rent Amount*: ${unit.rentAmount}\n📏 *Floor*: ${unit.floor}\n📐 *Size*: ${unit.size}\n━━━━━━━━━━━━━━━`;
    await sendImageMessage(phoneNumber, imageUrl, caption);
  } else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId);
    const unit = await Unit.findById(tenant.unitAssigned);
    caption = `✅ *Tenant Added*\n━━━━━━━━━━━━━━━\n👤 *Name*: ${tenant.fullName}\n🏠 *Property*: ${tenant.propertyName}\n🚪 *Unit*: ${unit ? unit.unitNumber : 'N/A'}\n📅 *Lease Start*: ${new Date(tenant.leaseStartDate).toLocaleDateString()}\n💵 *Deposit*: ${tenant.depositAmount}\n💰 *Monthly Rent*: ${tenant.monthlyRent}\n━━━━━━━━━━━━━━━`;
    await sendImageMessage(phoneNumber, imageUrl, caption);
  }
}

module.exports = {
  router,
  sendMessage,
  sendSummary,
};
