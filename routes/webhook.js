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
const DEFAULT_IMAGE_URL = 'https://via.placeholder.com/150';

const sessions = {}; // Stores session data keyed by phone number.
let userResponses = {}; // Temporarily stores interactive reply IDs.

// ----- Helper Functions -----
function isNumeric(value) {
  return /^-?\d+$/.test(value);
}

function generateUnitId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return 'U' + digits + letter;
}

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
      text: { body: message }
    }, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('Error sending WhatsApp message:', err.response ? err.response.data : err);
  }
}

async function sendImageMessage(phoneNumber, imageUrl, caption) {
  try {
    const response = await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'image',
      image: { link: imageUrl, caption }
    }, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('Image message sent:', response.data);
  } catch (err) {
    console.error('Error sending WhatsApp image message:', err.response ? err.response.data : err);
    await sendMessage(phoneNumber, caption);
  }
}

// ----- sendImageOption -----
// Prompts the user whether they want to upload an image.
async function sendImageOption(phoneNumber, type, entityId) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: `📸 Add Image to ${type.charAt(0).toUpperCase() + type.slice(1)}` },
      body: { text: `Would you like to upload an image for this ${type}?` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `upload_${type}_${entityId}`, title: 'Yes' } },
          { type: 'reply', reply: { id: `no_upload_${type}_${entityId}`, title: 'No' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// ----- Summary Function with Edit Prompt -----
async function sendSummary(phoneNumber, type, entityId, imageUrl) {
  let caption;
  if (type === 'property') {
    const property = await Property.findById(entityId);
    caption = `✅ *Property Added*\n━━━━━━━━━━━━━━━\n🏠 *Name*: ${property.name}\n📍 *Address*: ${property.address}\n🚪 *Units*: ${property.units}\n💰 *Total Amount*: ${property.totalAmount}\n━━━━━━━━━━━━━━━`;
  } else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('property');
    caption = `✅ *Unit Added*\n━━━━━━━━━━━━━━━\n🏠 *Property*: ${unit.property.name}\n🚪 *Unit ID*: ${unit.unitNumber}\n💰 *Rent Amount*: ${unit.rentAmount}\n📏 *Floor*: ${unit.floor}\n📐 *Size*: ${unit.size}\n━━━━━━━━━━━━━━━`;
  } else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId);
    const unit = await Unit.findById(tenant.unitAssigned);
    caption = `✅ *Tenant Added*\n━━━━━━━━━━━━━━━\n👤 *Name*: ${tenant.name}\n🏠 *Property*: ${tenant.propertyName}\n🚪 *Unit*: ${unit ? unit.unitNumber : 'N/A'}\n📅 *Lease Start*: ${tenant.lease_start}\n💵 *Deposit*: ${tenant.deposit}\n💰 *Rent Amount*: ${tenant.rent_amount}\n━━━━━━━━━━━━━━━`;
  }
  await sendImageMessage(phoneNumber, imageUrl, caption);
  await sendMessage(phoneNumber, caption);
  await sendEditConfirmation(phoneNumber, type, entityId);
}

// ----- Edit Confirmation & Field Selection -----
async function sendEditConfirmation(phoneNumber, type, entityId) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Edit Summary?' },
      body: { text: 'Would you like to edit any details?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `edit_${type}_${entityId}`, title: 'Edit' } },
          { type: 'reply', reply: { id: `confirm_${type}_${entityId}`, title: 'Confirm' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// For properties, ask which field to edit.
async function askPropertyEditOptions(phoneNumber, entityId) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Edit Property Details' },
      body: { text: 'Which field would you like to edit?\n1. Name\n2. Address\n3. Units\n4. Total Amount\n5. Image' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `edit_field_property_name_${entityId}`, title: 'Name' } },
          { type: 'reply', reply: { id: `edit_field_property_address_${entityId}`, title: 'Address' } },
          { type: 'reply', reply: { id: `edit_field_property_units_${entityId}`, title: 'Units' } },
          { type: 'reply', reply: { id: `edit_field_property_total_${entityId}`, title: 'Total Amount' } },
          { type: 'reply', reply: { id: `edit_field_property_image_${entityId}`, title: 'Image' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// ----- List Selection Functions (Numbered Text) -----
// Sends a numbered list of properties.
async function sendPropertySelectionMenu(phoneNumber, properties) {
  let message = '🏠 *Select a Property*\n';
  const selectionMap = {};
  properties.forEach((p, index) => {
    const num = index + 1;
    message += `${num}. ${p.name} - ${p.address}\n`;
    selectionMap[num] = p._id.toString();
  });
  message += '\nPlease reply with the number corresponding to your choice.';
  sessions[phoneNumber] = sessions[phoneNumber] || {};
  sessions[phoneNumber].propertySelectionMap = selectionMap;
  console.log(`Property Selection Map for ${phoneNumber}:`, selectionMap);
  await sendMessage(phoneNumber, message);
}

// ----- Additional Management Options -----
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
          { type: 'reply', reply: { id: 'manage_tenants', title: '👥 Tenants' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
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
          { type: 'reply', reply: { id: 'info', title: 'ℹ️ Info' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
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
          { type: 'reply', reply: { id: 'add_property', title: '➕ Add Property' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
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
          { type: 'reply', reply: { id: 'add_unit', title: '➕ Add Unit' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
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
          { type: 'reply', reply: { id: 'add_tenant', title: '➕ Add Tenant' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

function generateTenantId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return 'T' + digits + letter;
}

// ----- Main Webhook POST Handler -----
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
      const user = (await User.findOne({ phoneNumber: contactPhoneNumber })) || new User({ phoneNumber: contactPhoneNumber });
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
      
      // Capture interactive replies
      if (interactive && interactive.type === 'list_reply') {
        userResponses[fromNumber] = interactive.list_reply.id;
      } else if (interactive && interactive.type === 'button_reply') {
        userResponses[fromNumber] = interactive.button_reply.id;
      }
      sessions[fromNumber] = sessions[fromNumber] || { action: null };
      
      // ----- Handle Management Options -----
      if (userResponses[fromNumber] === 'manage') {
        await sendManageSubmenu(phoneNumber);
        delete userResponses[fromNumber];
        return res.sendStatus(200);
      }
      if (userResponses[fromNumber] === 'tools') {
        await sendToolsSubmenu(phoneNumber);
        delete userResponses[fromNumber];
        return res.sendStatus(200);
      }
      if (userResponses[fromNumber] === 'account_info') {
        const user = await User.findOne({ phoneNumber });
        const accountInfo = user
          ? `*👤 Account Information*\n📞 Phone: ${user.phoneNumber}\n🧑 Profile: ${user.profileName || 'N/A'}`
          : 'No account information found.';
        await sendMessage(phoneNumber, accountInfo);
        delete userResponses[fromNumber];
        return res.sendStatus(200);
      }
      if (userResponses[fromNumber] === 'manage_properties') {
        await sendPropertyOptions(phoneNumber);
        delete userResponses[fromNumber];
        return res.sendStatus(200);
      }
      if (userResponses[fromNumber] === 'manage_units') {
        await sendUnitOptions(phoneNumber);
        delete userResponses[fromNumber];
        return res.sendStatus(200);
      }
      if (userResponses[fromNumber] === 'manage_tenants') {
        await sendTenantOptions(phoneNumber);
        delete userResponses[fromNumber];
        return res.sendStatus(200);
      }
      if (userResponses[fromNumber] === 'add_property') {
        await sendMessage(phoneNumber, '🏠 *Add Property*\nLet’s start! Please provide the property name.');
        sessions[fromNumber].action = 'add_property_name';
        delete userResponses[fromNumber];
        return res.sendStatus(200);
      }
      if (userResponses[fromNumber] === 'add_unit') {
        const user = await User.findOne({ phoneNumber });
        const properties = await Property.find({ userId: user._id });
        if (!properties.length) {
          await sendMessage(phoneNumber, 'ℹ️ *No Properties*\nPlease add a property first.');
          delete userResponses[fromNumber];
          return res.sendStatus(200);
        } else {
          sessions[fromNumber].properties = properties;
          sessions[fromNumber].userId = user._id;
          await sendPropertySelectionMenu(phoneNumber, properties);
          sessions[fromNumber].action = 'add_unit_select_property';
          delete userResponses[fromNumber];
          return res.sendStatus(200);
        }
      }
      if (userResponses[fromNumber] === 'add_tenant') {
        const user = await User.findOne({ phoneNumber });
        const properties = await Property.find({ userId: user._id });
        if (!properties.length) {
          await sendMessage(phoneNumber, 'ℹ️ *No Properties*\nPlease add a property first.');
          delete userResponses[fromNumber];
          return res.sendStatus(200);
        } else {
          sessions[fromNumber].properties = properties;
          sessions[fromNumber].userId = user._id;
          await sendPropertySelectionMenu(phoneNumber, properties);
          sessions[fromNumber].action = 'add_tenant_select_property';
          delete userResponses[fromNumber];
          return res.sendStatus(200);
        }
      }
      
      // ----- Handle Numeric Selection for add_unit_select_property -----
      if (sessions[fromNumber].action === 'add_unit_select_property' && text && isNumeric(text)) {
        const num = parseInt(text);
        console.log(`Received numeric selection "${num}" for unit addition.`);
        if (sessions[fromNumber].propertySelectionMap && sessions[fromNumber].propertySelectionMap[num]) {
          const propertyId = sessions[fromNumber].propertySelectionMap[num];
          const properties = sessions[fromNumber].properties || await Property.find({ userId: sessions[fromNumber].userId });
          const selectedProperty = properties.find(p => p._id.toString() === propertyId);
          if (selectedProperty) {
            sessions[fromNumber].unitData = { property: selectedProperty._id };
            sessions[fromNumber].unitData.unitNumber = generateUnitId();
            console.log(`Unit ID generated: ${sessions[fromNumber].unitData.unitNumber}`);
            await sendMessage(phoneNumber, `Unit ID generated: ${sessions[fromNumber].unitData.unitNumber}. Please provide the rent amount for this unit.`);
            sessions[fromNumber].action = 'add_unit_rent';
            delete sessions[fromNumber].propertySelectionMap;
            return res.sendStatus(200);
          } else {
            await sendMessage(phoneNumber, '⚠️ *Invalid Selection*\nPlease select a valid property.');
            await sendPropertySelectionMenu(phoneNumber, properties);
            return res.sendStatus(200);
          }
        } else {
          await sendMessage(phoneNumber, '⚠️ *Selection Not Found*\nPlease reply with a valid number.');
          return res.sendStatus(200);
        }
      }
      
      // ----- Handle Unit Adding Flow -----
      if (text) {
        if (sessions[fromNumber].action === 'add_unit_rent') {
          if (isNumeric(text)) {
            sessions[fromNumber].unitData.rentAmount = parseFloat(text);
            console.log(`Rent amount set to: ${sessions[fromNumber].unitData.rentAmount}`);
            await sendMessage(phoneNumber, '📏 *Floor*\nWhich floor is this unit on? (e.g., 1, Ground)');
            sessions[fromNumber].action = 'add_unit_floor';
          } else {
            await sendMessage(phoneNumber, '⚠️ *Invalid entry*\nPlease provide a valid rent amount.');
          }
        } else if (sessions[fromNumber].action === 'add_unit_floor') {
          sessions[fromNumber].unitData.floor = text;
          await sendMessage(phoneNumber, '📐 *Size*\nWhat is the size of this unit (e.g., 500 sq ft)?');
          sessions[fromNumber].action = 'add_unit_size';
        } else if (sessions[fromNumber].action === 'add_unit_size') {
          const user = await User.findOne({ phoneNumber });
          const unit = new Unit({
            property: sessions[fromNumber].unitData.property,
            unitNumber: sessions[fromNumber].unitData.unitNumber,
            rentAmount: sessions[fromNumber].unitData.rentAmount,
            floor: sessions[fromNumber].unitData.floor,
            size: text,
            userId: user._id
          });
          await unit.save();
          sessions[fromNumber].entityType = 'unit';
          sessions[fromNumber].entityId = unit._id;
          await sendImageOption(phoneNumber, 'unit', unit._id);
          sessions[fromNumber].action = 'awaiting_image_choice';
          return res.sendStatus(200);
        }
      }
      
      // ----- Handle Image Upload Option when awaiting image choice -----
      if (sessions[fromNumber].action === 'awaiting_image_choice' && userResponses[fromNumber]) {
        const selectedOption = userResponses[fromNumber];
        if (selectedOption.startsWith('upload_')) {
          const parts = selectedOption.split('_');
          const type = parts[1];
          const entityId = parts.slice(2).join('_');
          const token = await generateUploadToken(phoneNumber, type, entityId);
          const imageUploadUrl = `${GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${entityId}?token=${token}`;
          const shortUrl = await shortenUrl(imageUploadUrl);
          await sendMessage(phoneNumber, `Please upload the image here (valid for 15 minutes): ${shortUrl}`);
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].entityType;
          delete sessions[fromNumber].entityId;
          delete userResponses[fromNumber];
          return res.sendStatus(200);
        } else if (selectedOption.startsWith('no_upload_')) {
          const parts = selectedOption.split('_');
          const type = parts[1];
          const entityId = parts.slice(2).join('_');
          if (type === 'property') {
            const property = await Property.findById(entityId);
            property.images.push(DEFAULT_IMAGE_URL);
            await property.save();
            await sendSummary(phoneNumber, 'property', entityId, DEFAULT_IMAGE_URL);
          } else if (type === 'unit') {
            const unit = await Unit.findById(entityId);
            unit.images.push(DEFAULT_IMAGE_URL);
            await unit.save();
            await sendSummary(phoneNumber, 'unit', entityId, DEFAULT_IMAGE_URL);
          } else if (type === 'tenant') {
            const tenant = await Tenant.findById(entityId);
            tenant.photo = DEFAULT_IMAGE_URL;
            await tenant.save();
            await sendSummary(phoneNumber, 'tenant', entityId, DEFAULT_IMAGE_URL);
          }
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].entityType;
          delete sessions[fromNumber].entityId;
          delete userResponses[fromNumber];
          return res.sendStatus(200);
        }
      }
      
      // ----- Handle Editing Interactive Replies -----
      if (interactive && userResponses[fromNumber]) {
        const selectedOption = userResponses[fromNumber];
        if (selectedOption.startsWith('edit_')) {
          const parts = selectedOption.split('_');
          const type = parts[1];
          const entityId = parts.slice(2).join('_');
          sessions[fromNumber].editing = { type, entityId };
          if (type === 'property') {
            await askPropertyEditOptions(phoneNumber, entityId);
          }
          // Extend for unit/tenant if desired.
          delete userResponses[fromNumber];
          return res.sendStatus(200);
        } else if (selectedOption.startsWith('confirm_')) {
          await sendMessage(phoneNumber, 'Summary confirmed.');
          delete sessions[fromNumber].editing;
          delete userResponses[fromNumber];
          return res.sendStatus(200);
        } else if (selectedOption.startsWith('edit_field_property_')) {
          const parts = selectedOption.split('_');
          const field = parts[3];
          const entityId = parts.slice(4).join('_');
          sessions[fromNumber].editing.field = field;
          await sendMessage(phoneNumber, `Please provide the new value for ${field}:`);
          delete userResponses[fromNumber];
          return res.sendStatus(200);
        }
      }
      
      // If in editing mode and receiving new text:
      if (text && sessions[fromNumber].editing && sessions[fromNumber].editing.field) {
        const editing = sessions[fromNumber].editing;
        if (editing.type === 'property') {
          const property = await Property.findById(editing.entityId);
          const field = editing.field;
          if (field === 'name') property.name = text;
          else if (field === 'address') property.address = text;
          else if (field === 'units') property.units = parseInt(text);
          else if (field === 'total') property.totalAmount = parseFloat(text);
          await property.save();
          await sendMessage(phoneNumber, `${field} updated successfully.`);
          delete sessions[fromNumber].editing.field;
          await sendSummary(phoneNumber, 'property', editing.entityId, DEFAULT_IMAGE_URL);
          return res.sendStatus(200);
        }
      }
      
      // ----- Existing Flows for Adding Entities -----
      if (text) {
        // PROPERTY ADDING FLOW
        if (sessions[fromNumber].action === 'add_property_name') {
          sessions[fromNumber].propertyData = { name: text };
          await sendMessage(phoneNumber, '📍 *Property Address*\nPlease provide the address of the property.');
          sessions[fromNumber].action = 'add_property_address';
        } else if (sessions[fromNumber].action === 'add_property_address') {
          sessions[fromNumber].propertyData.address = text;
          await sendMessage(phoneNumber, '🏠 *Number of Units*\nHow many units does this property have? (e.g., 5)');
          sessions[fromNumber].action = 'add_property_units';
        } else if (sessions[fromNumber].action === 'add_property_units') {
          if (isNumeric(text)) {
            sessions[fromNumber].propertyData.units = parseInt(text);
            await sendMessage(phoneNumber, '💰 *Total Amount*\nWhat is the total amount for this property (e.g., 5000)?');
            sessions[fromNumber].action = 'add_property_totalAmount';
          } else {
            await sendMessage(phoneNumber, '⚠️ *Invalid entry*\nPlease provide a valid number for units.');
          }
        } else if (sessions[fromNumber].action === 'add_property_totalAmount') {
          if (isNumeric(text)) {
            const user = await User.findOne({ phoneNumber });
            const property = new Property({
              name: sessions[fromNumber].propertyData.name,
              address: sessions[fromNumber].propertyData.address,
              units: sessions[fromNumber].propertyData.units,
              totalAmount: parseFloat(text),
              userId: user._id
            });
            await property.save();
            sessions[fromNumber].entityType = 'property';
            sessions[fromNumber].entityId = property._id;
            await sendImageOption(phoneNumber, 'property', property._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
          } else {
            await sendMessage(phoneNumber, '⚠️ *Invalid entry*\nPlease provide a valid total amount.');
          }
        }
        // UNIT ADDING FLOW
        else if (sessions[fromNumber].action === 'add_unit_rent') {
          if (isNumeric(text)) {
            sessions[fromNumber].unitData.rentAmount = parseFloat(text);
            await sendMessage(phoneNumber, '📏 *Floor*\nWhich floor is this unit on? (e.g., 1, Ground)');
            sessions[fromNumber].action = 'add_unit_floor';
          } else {
            await sendMessage(phoneNumber, '⚠️ *Invalid entry*\nPlease provide a valid rent amount.');
          }
        } else if (sessions[fromNumber].action === 'add_unit_floor') {
          sessions[fromNumber].unitData.floor = text;
          await sendMessage(phoneNumber, '📐 *Size*\nWhat is the size of this unit (e.g., 500 sq ft)?');
          sessions[fromNumber].action = 'add_unit_size';
        } else if (sessions[fromNumber].action === 'add_unit_size') {
          const user = await User.findOne({ phoneNumber });
          const unit = new Unit({
            property: sessions[fromNumber].unitData.property,
            unitNumber: sessions[fromNumber].unitData.unitNumber,
            rentAmount: sessions[fromNumber].unitData.rentAmount,
            floor: sessions[fromNumber].unitData.floor,
            size: text,
            userId: user._id
          });
          await unit.save();
          sessions[fromNumber].entityType = 'unit';
          sessions[fromNumber].entityId = unit._id;
          await sendImageOption(phoneNumber, 'unit', unit._id);
          sessions[fromNumber].action = 'awaiting_image_choice';
        }
        // TENANT ADDING FLOW
        else if (sessions[fromNumber].action === 'add_tenant_name') {
          sessions[fromNumber].tenantData.name = text;
          await sendMessage(phoneNumber, '📅 *Lease Start Date*\nWhen does the lease start? (e.g., DD-MM-YYYY)');
          sessions[fromNumber].action = 'add_tenant_lease_start';
        } else if (sessions[fromNumber].action === 'add_tenant_lease_start') {
          sessions[fromNumber].tenantData.lease_start = text;
          await sendMessage(phoneNumber, '💵 *Deposit*\nWhat is the deposit amount?');
          sessions[fromNumber].action = 'add_tenant_deposit';
        } else if (sessions[fromNumber].action === 'add_tenant_deposit') {
          if (isNumeric(text)) {
            sessions[fromNumber].tenantData.deposit = parseFloat(text);
            await sendMessage(phoneNumber, '💰 *Rent Amount*\nWhat is the monthly rent amount?');
            sessions[fromNumber].action = 'add_tenant_rent';
          } else {
            await sendMessage(phoneNumber, '⚠️ *Invalid entry*\nPlease provide a valid deposit amount.');
          }
        } else if (sessions[fromNumber].action === 'add_tenant_rent') {
          if (isNumeric(text)) {
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
              tenant_id: generateTenantId()
            });
            await tenant.save();
            sessions[fromNumber].entityType = 'tenant';
            sessions[fromNumber].entityId = tenant._id;
            await sendImageOption(phoneNumber, 'tenant', tenant._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
          } else {
            await sendMessage(phoneNumber, '⚠️ *Invalid entry*\nPlease provide a valid rent amount.');
          }
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
                  { type: 'reply', reply: { id: 'tools', title: '🧰 Tools' } }
                ]
              }
            }
          };
          await axios.post(WHATSAPP_API_URL, buttonMenu, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
          });
        }
      }
    }
  }
  res.sendStatus(200);
});

module.exports = {
  router,
  sendMessage,
  sendSummary
};
