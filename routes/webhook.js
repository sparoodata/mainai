const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const UploadToken = require('../models/UploadToken');
const Groq = require('groq-sdk');
const crypto = require('crypto');
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
    console.error('Error shortening URL:', error);
    return longUrl;
  }
}

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

// Validation functions (unchanged)
function isValidName(name) {
  const regex = /^[a-zA-Z0-9 ]+$/;
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 40 && regex.test(name);
}

function isValidAddress(address) {
  const regex = /^[a-zA-Z0-9 ]+$/;
  return typeof address === 'string' && address.trim().length > 0 && address.length <= 40 && regex.test(address);
}

function isValidUnits(units) {
  const num = parseInt(units);
  return !isNaN(num) && num > 0 && Number.isInteger(num);
}

function isValidTotalAmount(amount) {
  const num = parseFloat(amount);
  return !isNaN(num) && num > 0;
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
      const contactPhoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile.name;

      const user = await User.findOne({ phoneNumber: contactPhoneNumber }) || new User({ phoneNumber: contactPhoneNumber });
      user.profileName = profileName || user.profileName;
      await user.save();
    }

    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;
      const phoneNumber = `+${fromNumber}`;
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      if (interactive && interactive.type === 'list_reply') {
        userResponses[fromNumber] = interactive.list_reply.id;
      } else if (interactive && interactive.type === 'button_reply') {
        userResponses[fromNumber] = interactive.button_reply.id;
      }

      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      if (text) {
        if (sessions[fromNumber].action === 'add_property_name') {
          if (isValidName(text)) {
            sessions[fromNumber].propertyData = { name: text };
            await sendMessage(fromNumber, '📍 *Property Address* \nPlease provide the address of the property.');
            sessions[fromNumber].action = 'add_property_address';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease retry with a valid property name (e.g., "Sunset Apartments"). Max 40 characters, no special characters.');
          }
        } else if (sessions[fromNumber].action === 'add_property_address') {
          if (isValidAddress(text)) {
            sessions[fromNumber].propertyData.address = text;
            await sendMessage(fromNumber, '🏠 *Number of Units* \nHow many units does this property have? (e.g., 5)');
            sessions[fromNumber].action = 'add_property_units';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease retry with a valid address (e.g., "123 Main St"). Max 40 characters, no special characters.');
          }
        } else if (sessions[fromNumber].action === 'add_property_units') {
          if (isValidUnits(text)) {
            sessions[fromNumber].propertyData.units = parseInt(text);
            await sendMessage(fromNumber, '💰 *Total Amount* \nWhat is the total amount for this property (e.g., 5000)?');
            sessions[fromNumber].action = 'add_property_totalAmount';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease retry with a valid number of units (e.g., 5). Must be a positive whole number.');
          }
        } else if (sessions[fromNumber].action === 'add_property_totalAmount') {
          if (isValidTotalAmount(text)) {
            const user = await User.findOne({ phoneNumber });
            const property = new Property({
              name: sessions[fromNumber].propertyData.name,
              address: sessions[fromNumber].propertyData.address,
              units: sessions[fromNumber].propertyData.units,
              totalAmount: parseFloat(text),
              userId: user._id,
            });
            await property.save();

            const token = await generateUploadToken(phoneNumber, 'property', property._id);
            const imageUploadUrl = `${GLITCH_HOST}/upload-image/${fromNumber}/property/${property._id}?token=${token}`;
            const shortUrl = await shortenUrl(imageUploadUrl);
            await sendMessage(fromNumber, `✅ *Property Added* \nProperty "${property.name}" has been added successfully!\n📸 *Upload Image* \nClick here to upload an image for this property (valid once): ${shortUrl}`);
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].propertyData;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease retry with a valid total amount (e.g., 5000). Must be a positive number.');
          }
        } else if (sessions[fromNumber].action === 'add_unit_select_property') {
          const propertyId = userResponses[fromNumber];
          const properties = sessions[fromNumber].properties;
          const selectedProperty = properties.find(p => p._id.toString() === propertyId);

          if (selectedProperty) {
            sessions[fromNumber].unitData = { property: selectedProperty._id };
            const units = await Unit.find({ property: selectedProperty._id, userId: sessions[fromNumber].userId });
            if (!units.length) {
              await sendMessage(fromNumber, 'ℹ️ *No Units* \nPlease add a unit to this property first.');
              sessions[fromNumber].action = 'add_unit_number'; // Allow adding a unit directly
            } else {
              await sendUnitSelectionMenu(fromNumber, units);
              sessions[fromNumber].action = 'add_unit_select_unit';
            }
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease select a valid property from the menu.');
            await sendPropertySelectionMenu(fromNumber, properties);
          }
        } else if (sessions[fromNumber].action === 'add_unit_number') {
          sessions[fromNumber].unitData.unitNumber = text;
          await sendMessage(fromNumber, '💰 *Rent Amount* \nWhat is the rent amount for this unit?');
          sessions[fromNumber].action = 'add_unit_rent';
        } else if (sessions[fromNumber].action === 'add_unit_rent') {
          sessions[fromNumber].unitData.rentAmount = parseFloat(text);
          await sendMessage(fromNumber, '📏 *Floor* \nWhich floor is this unit on? (e.g., 1, Ground)');
          sessions[fromNumber].action = 'add_unit_floor';
        } else if (sessions[fromNumber].action === 'add_unit_floor') {
          sessions[fromNumber].unitData.floor = text;
          await sendMessage(fromNumber, '📐 *Size* \nWhat is the size of this unit (e.g., 500 sq ft)?');
          sessions[fromNumber].action = 'add_unit_size';
        } else if (sessions[fromNumber].action === 'add_unit_size') {
          const user = await User.findOne({ phoneNumber });
          const unit = new Unit({
            property: sessions[fromNumber].unitData.property,
            unitNumber: sessions[fromNumber].unitData.unitNumber,
            rentAmount: sessions[fromNumber].unitData.rentAmount,
            floor: sessions[fromNumber].unitData.floor,
            size: text,
            userId: user._id,
          });
          await unit.save();

          const token = await generateUploadToken(phoneNumber, 'unit', unit._id);
          const imageUploadUrl = `${GLITCH_HOST}/upload-image/${fromNumber}/unit/${unit._id}?token=${token}`;
          const shortUrl = await shortenUrl(imageUploadUrl);
          await sendMessage(fromNumber, `✅ *Unit Added* \nUnit "${unit.unitNumber}" has been added successfully!\n📸 *Upload Image* \nClick here to upload an image for this unit (valid once): ${shortUrl}`);
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].unitData;
          delete sessions[fromNumber].properties;
        } else if (sessions[fromNumber].action === 'add_tenant_select_property') {
          const propertyId = userResponses[fromNumber];
          const properties = sessions[fromNumber].properties;
          const selectedProperty = properties.find(p => p._id.toString() === propertyId);

          if (selectedProperty) {
            sessions[fromNumber].tenantData = { propertyId: selectedProperty._id };
            const units = await Unit.find({ property: selectedProperty._id, userId: sessions[fromNumber].userId });
            if (!units.length) {
              await sendMessage(fromNumber, 'ℹ️ *No Units* \nPlease add a unit to this property first.');
              sessions[fromNumber].action = null;
              delete sessions[fromNumber].tenantData;
            } else {
              await sendUnitSelectionMenu(fromNumber, units);
              sessions[fromNumber].action = 'add_tenant_select_unit';
            }
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease select a valid property from the menu.');
            await sendPropertySelectionMenu(fromNumber, properties);
          }
        } else if (sessions[fromNumber].action === 'add_tenant_select_unit') {
          const unitId = userResponses[fromNumber];
          const units = await Unit.find({ property: sessions[fromNumber].tenantData.propertyId }).populate('property');
          const selectedUnit = units.find(u => u._id.toString() === unitId);

          if (selectedUnit) {
            sessions[fromNumber].tenantData.unitAssigned = selectedUnit._id;
            sessions[fromNumber].tenantData.propertyName = selectedUnit.property.name;
            await sendMessage(fromNumber, '👤 *Tenant Name* \nPlease provide the tenant’s full name.');
            sessions[fromNumber].action = 'add_tenant_name';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease select a valid unit from the menu.');
            await sendUnitSelectionMenu(fromNumber, units);
          }
        } else if (sessions[fromNumber].action === 'add_tenant_name') {
          sessions[fromNumber].tenantData.name = text;
          await sendMessage(fromNumber, '📅 *Lease Start Date* \nWhen does the lease start? (e.g., 2025-01-01)');
          sessions[fromNumber].action = 'add_tenant_lease_start';
        } else if (sessions[fromNumber].action === 'add_tenant_lease_start') {
          sessions[fromNumber].tenantData.lease_start = text;
          await sendMessage(fromNumber, '💵 *Deposit* \nWhat is the deposit amount?');
          sessions[fromNumber].action = 'add_tenant_deposit';
        } else if (sessions[fromNumber].action === 'add_tenant_deposit') {
          sessions[fromNumber].tenantData.deposit = parseFloat(text);
          await sendMessage(fromNumber, '💰 *Rent Amount* \nWhat is the monthly rent amount?');
          sessions[fromNumber].action = 'add_tenant_rent';
        } else if (sessions[fromNumber].action === 'add_tenant_rent') {
          const user = await User.findOne({ phoneNumber });
          const tenant = new Tenant({
            name: sessions[fromNumber].tenantData.name,
            phoneNumber: user.phoneNumber,
            userId: user._id,
            propertyName: sessions[fromNumber].tenantData.propertyName,
            unitAssigned: sessions[fromNumber].tenantData.unitAssigned,
            lease_start: new Date(sessions[fromNumber].tenantData.lease_start),
            deposit: sessions[fromNumber].tenantData.deposit,
            rent_amount: parseFloat(text),
            tenant_id: generateTenantId(),
          });
          await tenant.save();

          const token = await generateUploadToken(phoneNumber, 'tenant', tenant._id);
          const imageUploadUrl = `${GLITCH_HOST}/upload-image/${fromNumber}/tenant/${tenant._id}?token=${token}`;
          const shortUrl = await shortenUrl(imageUploadUrl);
          await sendMessage(fromNumber, `✅ *Tenant Added* \nTenant "${tenant.name}" has been added successfully!\n📸 *Upload Photo* \nClick here to upload a photo for this tenant (valid once): ${shortUrl}`);
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
        }
      }

      if (interactive) {
        const selectedOption = userResponses[fromNumber];

        if (selectedOption === 'account_info') {
          const user = await User.findOne({ phoneNumber });
          const accountInfoMessage = user ? `
*👤 Account Information*
━━━━━━━━━━━━━━━
📞 *Phone*: ${user.phoneNumber}
✅ *Verified*: ${user.verified ? 'Yes' : 'No'}
🧑 *Profile Name*: ${user.profileName || 'N/A'}
📅 *Registration Date*: ${user.registrationDate ? user.registrationDate.toLocaleDateString() : 'N/A'}
💰 *Subscription*: ${user.subscription}
━━━━━━━━━━━━━━━
          ` : '⚠️ *No Account Found* \nNo account information is available for this number.';
          await sendMessage(fromNumber, accountInfoMessage);
        } else if (selectedOption === 'manage') {
          await sendManageSubmenu(fromNumber);
        } else if (selectedOption === 'tools') {
          await sendToolsSubmenu(fromNumber);
        } else if (selectedOption === 'manage_properties') {
          await sendPropertyOptions(fromNumber);
        } else if (selectedOption === 'manage_units') {
          await sendUnitOptions(fromNumber);
        } else if (selectedOption === 'manage_tenants') {
          await sendTenantOptions(fromNumber);
        } else if (selectedOption === 'add_property') {
          await sendMessage(fromNumber, '🏠 *Add Property* \nLet’s start! Please provide the property name.');
          sessions[fromNumber].action = 'add_property_name';
        } else if (selectedOption === 'add_unit') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(fromNumber, 'ℹ️ *No Properties* \nPlease add a property first.');
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            await sendPropertySelectionMenu(fromNumber, properties);
            sessions[fromNumber].action = 'add_unit_select_property';
          }
        } else if (selectedOption === 'add_tenant') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(fromNumber, 'ℹ️ *No Properties* \nPlease add a property first.');
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            await sendPropertySelectionMenu(fromNumber, properties);
            sessions[fromNumber].action = 'add_tenant_select_property';
          }
        }
      }
    }
  }
  res.sendStatus(200);
});

// New WhatsApp Menu Functions
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
        sections: [{
          title: 'Properties',
          rows: properties.map(p => ({
            id: p._id.toString(),
            title: p.name.slice(0, 24), // WhatsApp limits title to 24 chars
            description: p.address.slice(0, 72), // WhatsApp limits description to 72 chars
          })),
        }],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, listMenu, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

async function sendUnitSelectionMenu(phoneNumber, units) {
  const listMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: '🚪 Select a Unit' },
      body: { text: 'Please choose a unit:' },
      footer: { text: 'Select from the list below' },
      action: {
        button: 'Choose Unit',
        sections: [{
          title: 'Units',
          rows: units.map(u => ({
            id: u._id.toString(),
            title: u.unitNumber.slice(0, 24),
            description: `${u.property.name} - Floor: ${u.floor}`.slice(0, 72),
          })),
        }],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, listMenu, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

async function sendManageSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🛠️ Manage Options' },
      body: { text: '*What would you like to manage?*' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'manage_properties', title: '🏠 Properties' } },
          { type: 'reply', reply: { id: 'manage_units', title: '🚪 Units' } },
          { type: 'reply', reply: { id: 'manage_tenants', title: '👥 Tenants' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

async function sendToolsSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🧰 Tools' },
      body: { text: '*Select a tool:*' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'reports', title: '📊 Reports' } },
          { type: 'reply', reply: { id: 'manage', title: '🔧 Maintenance' } },
          { type: 'reply', reply: { id: 'info', title: 'ℹ️ Info' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

async function sendPropertyOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🏠 Property Management' },
      body: { text: '*Manage your properties:*' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_property', title: '➕ Add Property' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

async function sendUnitOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🚪 Unit Management' },
      body: { text: '*Manage your units:*' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_unit', title: '➕ Add Unit' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

async function sendTenantOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '👥 Tenant Management' },
      body: { text: '*Manage your tenants:*' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_tenant', title: '➕ Add Tenant' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

function generateTenantId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return 'T' + digits + letter;
}

module.exports = {
  router,
  sendMessage,
};