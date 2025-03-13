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
const DEFAULT_IMAGE_URL = 'https://via.placeholder.com/150';

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

async function generateUploadToken(phoneNumber, type) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const uploadToken = new UploadToken({ token, phoneNumber, type, expiresAt });
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

async function sendImageOption(phoneNumber, type) {
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
          { type: 'reply', reply: { id: `upload_${type}`, title: 'Yes' } },
          { type: 'reply', reply: { id: `no_upload_${type}`, title: 'No' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

async function sendSummary(phoneNumber, type, data, imageUrl) {
  await sendImageMessage(phoneNumber, imageUrl);
  let summary;
  if (type === 'property') {
    summary = `
🏠 *Property Summary*
━━━━━━━━━━━━━━━
🏠 *Name*: ${data.name}
📍 *Address*: ${data.address}
🚪 *Units*: ${data.units}
💰 *Total*: $${data.totalAmount}
📸 *Image*: Attached above
━━━━━━━━━━━━━━━
*Please review the details.*`;
  } else if (type === 'unit') {
    const property = await Property.findById(data.property);
    summary = `
🚪 *Unit Summary*
━━━━━━━━━━━━━━━
🏠 *Property*: ${property.name}
🚪 *Unit ID*: ${data.unitId}
💰 *Rent*: $${data.rentAmount}
📏 *Floor*: ${data.floor}
📐 *Size*: ${data.size}
📸 *Image*: Attached above
━━━━━━━━━━━━━━━
*Please review the details.*`;
  } else if (type === 'tenant') {
    const unit = await Unit.findById(data.unitAssigned);
    summary = `
👤 *Tenant Summary*
━━━━━━━━━━━━━━━
👤 *Name*: ${data.name}
🏠 *Property*: ${data.propertyName}
🚪 *Unit ID*: ${unit.unitId}
📅 *Lease Start*: ${data.lease_start}
💵 *Deposit*: $${data.deposit}
💰 *Rent*: $${data.rent_amount}
📋 *Tenant ID*: ${data.tenant_id}
📸 *Image*: Attached above
━━━━━━━━━━━━━━━
*Please review the details.*`;
  }
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: `✅ ${type.charAt(0).toUpperCase() + type.slice(1)} Details` },
      body: { text: summary },
      footer: { text: 'Confirm or Edit?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `confirm_${type}`, title: 'Confirm' } },
          { type: 'reply', reply: { id: `edit_${type}`, title: 'Edit' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, { headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

async function saveAndSendFinalSummary(phoneNumber, type, data) {
  const user = await User.findOne({ phoneNumber });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ User not found. Please restart by typing "help".');
    return null;
  }
  let entityId;
  if (type === 'property') {
    const property = new Property({
      name: data.name,
      address: data.address,
      units: data.units,
      totalAmount: data.totalAmount,
      userId: user._id,
      images: [data.imageUrl],
    });
    await property.save();
    entityId = property._id;
  } else if (type === 'unit') {
    const unit = new Unit({
      property: data.property,
      unitId: data.unitId,
      rentAmount: data.rentAmount,
      floor: data.floor,
      size: data.size,
      userId: user._id,
      images: [data.imageUrl],
    });
    await unit.save();
    entityId = unit._id;
  } else if (type === 'tenant') {
    const tenant = new Tenant({
      name: data.name,
      phoneNumber: user.phoneNumber,
      userId: user._id,
      propertyName: data.propertyName,
      unitAssigned: data.unitAssigned,
      lease_start: data.lease_start,
      deposit: data.deposit,
      rent_amount: data.rent_amount,
      tenant_id: data.tenant_id,
      photo: data.imageUrl,
    });
    await tenant.save();
    entityId = tenant._id;
  }
  let finalSummary;
  if (type === 'property') {
    finalSummary = `
🎉 *Property Added Successfully!*
━━━━━━━━━━━━━━━
🏠 *Name*: ${data.name}
📍 *Address*: ${data.address}
🚪 *Units*: ${data.units}
💰 *Total*: $${data.totalAmount}
📸 *Image*: Attached above
━━━━━━━━━━━━━━━
*What’s next? Type "help" for options!*`;
  } else if (type === 'unit') {
    const property = await Property.findById(data.property);
    finalSummary = `
🎉 *Unit Added Successfully!*
━━━━━━━━━━━━━━━
🏠 *Property*: ${property.name}
🚪 *Unit ID*: ${data.unitId}
💰 *Rent*: $${data.rentAmount}
📏 *Floor*: ${data.floor}
📐 *Size*: ${data.size}
📸 *Image*: Attached above
━━━━━━━━━━━━━━━
*What’s next? Type "help" for options!*`;
  } else if (type === 'tenant') {
    const unit = await Unit.findById(data.unitAssigned);
    finalSummary = `
🎉 *Tenant Added Successfully!*
━━━━━━━━━━━━━━━
👤 *Name*: ${data.name}
🏠 *Property*: ${data.propertyName}
🚪 *Unit ID*: ${unit.unitId}
📅 *Lease Start*: ${data.lease_start}
💵 *Deposit*: $${data.deposit}
💰 *Rent*: $${data.rent_amount}
📋 *Tenant ID*: ${data.tenant_id}
📸 *Image*: Attached above
━━━━━━━━━━━━━━━
*What’s next? Type "help" for options!*`;
  }
  await sendImageMessage(phoneNumber, data.imageUrl);
  await sendMessage(phoneNumber, finalSummary);
  return entityId;
}

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

function isValidDate(dateStr) {
  const regex = /^(\d{2})-(\d{2})-(\d{4})$/;
  if (!regex.test(dateStr)) return false;
  const [day, month, year] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getDate() === day && date.get