const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const UploadToken = require('../models/UploadToken');
const crypto = require('crypto');

const router = express.Router();

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;
const DEFAULT_IMAGE_URL = 'https://via.placeholder.com/150'; // Default image URL

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
  const uploadToken = new UploadToken({ token, phoneNumber, type, entityId, expiresAt });
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
      headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Error sending WhatsApp message:', err.response ? err.response.data : err);
    await sendMessage(phoneNumber, '⚠️ Oops! Something went wrong. Please try again.');
  }
}

async function sendImageMessage(phoneNumber, imageUrl) {
  try {
    await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'image',
      image: { link: imageUrl },
    }, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Error sending WhatsApp image:', err.response ? err.response.data : err);
    await sendMessage(phoneNumber, '⚠️ Couldn’t send the image. Using default instead.');
    await sendImageMessage(phoneNumber, DEFAULT_IMAGE_URL);
  }
}

async function sendImageOption(phoneNumber, type, entityId) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: `📸 Add a Photo` },
      body: { text: `Want to attach a photo to this ${type}?` },
      footer: { text: 'Choose an option below' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `upload_${type}_${entityId}`, title: 'Yes' } },
          { type: 'reply', reply: { id: `no_upload_${type}_${entityId}`, title: 'No' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

async function sendSummary(phoneNumber, type, entityId, imageUrl) {
  await sendImageMessage(phoneNumber, imageUrl);
  let summary;
  if (type === 'property') {
    const property = await Property.findById(entityId);
    summary = `
🎉 *Property Added Successfully!*
━━━━━━━━━━━━━━━
🏠 *Name*: ${property.name}
📍 *Address*: ${property.address}
🚪 *Units*: ${property.units}
💰 *Total*: $${property.totalAmount}
━━━━━━━━━━━━━━━
*What’s next? Type "help" for options!*`;
  } else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('property');
    summary = `
🎉 *Unit Added Successfully!*
━━━━━━━━━━━━━━━
🏠 *Property*: ${unit.property.name}
🚪 *Unit*: ${unit.unitNumber}
💰 *Rent*: $${unit.rentAmount}
📏 *Floor*: ${unit.floor}
📐 *Size*: ${unit.size}
━━━━━━━━━━━━━━━
*What’s next? Type "help" for options!*`;
  } else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId);
    const unit = await Unit.findById(tenant.unitAssigned);
    summary = `
🎉 *Tenant Added Successfully!*
━━━━━━━━━━━━━━━
👤 *Name*: ${tenant.name}
🏠 *Property*: ${tenant.propertyName}
🚪 *Unit*: ${unit.unitNumber}
📅 *Lease Start*: ${tenant.lease_start}
💵 *Deposit*: $${tenant.deposit}
💰 *Rent*: $${tenant.rent_amount}
━━━━━━━━━━━━━━━
*What’s next? Type "help" for options!*`;
  }
  await sendMessage(phoneNumber, summary);
}

function isValidName(name) {
  const regex = /^[a-zA-Z0-9 ]+$/;
  return typeof name === 'string' && name.trim().length > 0 && name.length <=40 && regex.test(name);
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

function isValidDate(dateStr) {
  const regex = /^(\d{2})-(\d{2})-(\d{4})$/;
  if (!regex.test(dateStr)) return false;
  const [day, month, year] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getDate() === day && date.getMonth() === month - 1 && date.getFullYear() === year;
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

      console.log(`Message from ${fromNumber}:`, { text, interactive });

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
            await sendMessage(fromNumber, '📍 *Step 2: Address*\nWhere is this property located? (e.g., 123 Main St)');
            sessions[fromNumber].action = 'add_property_address';
          } else {
            await sendMessage(fromNumber, '⚠️ *Oops!*\nPlease use a valid name (e.g., "Sunset Apartments"). No special characters, max 40 letters.');
          }
        } else if (sessions[fromNumber].action === 'add_property_address') {
          if (isValidAddress(text)) {
            sessions[fromNumber].propertyData.address = text;
            await sendMessage(fromNumber, '🚪 *Step 3: Units*\nHow many units does it have? (e.g., 5)');
            sessions[fromNumber].action = 'add_property_units';
          } else {
            await sendMessage(fromNumber, '⚠️ *Oops!*\nPlease use a valid address (e.g., "123 Main St"). No special characters, max 40 letters.');
          }
        } else if (sessions[fromNumber].action === 'add_property_units') {
          if (isValidUnits(text)) {
            sessions[fromNumber].propertyData.units = parseInt(text);
            await sendMessage(fromNumber, '💰 *Step 4: Total Amount*\nWhat’s the total value? (e.g., 5000)');
            sessions[fromNumber].action = 'add_property_totalAmount';
          } else {
            await sendMessage(fromNumber, '⚠️ *Oops!*\nPlease enter a positive whole number (e.g., 5).');
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
            sessions[fromNumber].entityType = 'property';
            sessions[fromNumber].entityId = property._id;
            await sendImageOption(fromNumber, 'property', property._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
            delete sessions[fromNumber].propertyData;
          } else {
            await sendMessage(fromNumber, '⚠️ *Oops!*\nPlease enter a valid amount (e.g., 5000).');
          }
        } else if (sessions[fromNumber].action === 'add_unit_number') {
          sessions[fromNumber].unitData.unitNumber = text;
          await sendMessage(fromNumber, '💰 *Step 2: Rent*\nWhat’s the monthly rent? (e.g., 1000)');
          sessions[fromNumber].action = 'add_unit_rent';
        } else if (sessions[fromNumber].action === 'add_unit_rent') {
          if (isValidTotalAmount(text)) {
            sessions[fromNumber].unitData.rentAmount = parseFloat(text);
            await sendMessage(fromNumber, '📏 *Step 3: Floor*\nWhich floor is it on? (e.g., 1 or Ground)');
            sessions[fromNumber].action = 'add_unit_floor';
          } else {
            await sendMessage(fromNumber, '⚠️ *Oops!*\nPlease enter a valid rent amount (e.g., 1000).');
          }
        } else if (sessions[fromNumber].action === 'add_unit_floor') {
          sessions[fromNumber].unitData.floor = text;
          await sendMessage(fromNumber, '📐 *Step 4: Size*\nWhat’s the size? (e.g., 500 sq ft)');
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
          sessions[fromNumber].entityType = 'unit';
          sessions[fromNumber].entityId = unit._id;
          await sendImageOption(fromNumber, 'unit', unit._id);
          sessions[fromNumber].action = 'awaiting_image_choice';
          delete sessions[fromNumber].unitData;
        } else if (sessions[fromNumber].action === 'add_tenant_name') {
          sessions[fromNumber].tenantData.name = text;
          await sendMessage(fromNumber, '📅 *Step 2: Lease Start*\nWhen does the lease begin? (DD-MM-YYYY, e.g., 01-01-2025)');
          sessions[fromNumber].action = 'add_tenant_lease_start';
        } else if (sessions[fromNumber].action === 'add_tenant_lease_start') {
          if (isValidDate(text)) {
            sessions[fromNumber].tenantData.lease_start = text;
            await sendMessage(fromNumber, '💵 *Step 3: Deposit*\nWhat’s the deposit amount? (e.g., 5000)');
            sessions[fromNumber].action = 'add_tenant_deposit';
          } else {
            await sendMessage(fromNumber, '⚠️ *Oops!*\nPlease use DD-MM-YYYY format (e.g., 01-01-2025).');
          }
        } else if (sessions[fromNumber].action === 'add_tenant_deposit') {
          if (isValidTotalAmount(text)) {
            sessions[fromNumber].tenantData.deposit = parseFloat(text);
            await sendMessage(fromNumber, '💰 *Step 4: Rent*\nWhat’s the monthly rent? (e.g., 1000)');
            sessions[fromNumber].action = 'add_tenant_rent';
          } else {
            await sendMessage(fromNumber, '⚠️ *Oops!*\nPlease enter a valid amount (e.g., 5000).');
          }
        } else if (sessions[fromNumber].action === 'add_tenant_rent') {
          if (isValidTotalAmount(text)) {
            const user = await User.findOne({ phoneNumber });
            const tenant = new Tenant({
              name: sessions[fromNumber].tenantData.name,
              phoneNumber: user.phoneNumber,
              userId: user._id,
              propertyName: sessions[fromNumber].tenantData.propertyName,
              unitAssigned: sessions[fromNumber].tenantData.unitAssigned,
              lease_start: sessions[fromNumber].tenantData.lease_start,
              deposit: sessions[fromNumber].tenantData.deposit,
              rent_amount: parseFloat(text),
              tenant_id: generateTenantId(),
            });
            await tenant.save();
            sessions[fromNumber].entityType = 'tenant';
            sessions[fromNumber].entityId = tenant._id;
            await sendImageOption(fromNumber, 'tenant', tenant._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
            delete sessions[fromNumber].tenantData;
          } else {
            await sendMessage(fromNumber, '⚠️ *Oops!*\nPlease enter a valid rent amount (e.g., 1000).');
          }
        } else if (text.toLowerCase() === 'help' || text.toLowerCase() === 'start') {
          await sendWelcomeMenu(fromNumber);
        } else {
          await sendMessage