const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const Groq = require('groq-sdk');

const User = require('../models/User');   // Your user model
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const UploadToken = require('../models/UploadToken');
const Image = require('../models/Image'); // if you use an Image model
// ^ Make sure these require paths match your project structure

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const router = express.Router();

// Replace with your own info
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;
const DEFAULT_IMAGE_URL = 'https://via.placeholder.com/150';

const sessions = {};
let userResponses = {};

/** 
 * Utility to chunk an array into subarrays of up to `size` items each 
 * (for chunked interactive lists). 
 */
function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

/** 
 * Generate unique IDs for each entity 
 * E.g.: P####X for properties, U####X for units, T####X for tenants 
 */
function generatePropertyId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `P${digits}${letter}`;
}
function generateUnitId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `U${digits}${letter}`;
}
function generateTenantId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `T${digits}${letter}`;
}

/** 
 * Create a short-lived token for image upload 
 */
async function generateUploadToken(phoneNumber, type, entityId) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
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
 * Send a plain text WhatsApp message 
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
    console.error('Error sending WhatsApp message:', err.response?.data || err);
  }
}

/** 
 * Send an image message with caption 
 */
async function sendImageMessage(phoneNumber, imageUrl, caption) {
  try {
    await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'image',
        image: {
          link: imageUrl,
          caption: caption,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('Error sending WhatsApp image message:', err.response?.data || err);
    // Fallback to text
    await sendMessage(phoneNumber, caption);
  }
}

/** 
 * Send a final summary after adding a property/unit/tenant 
 */
async function sendSummary(phoneNumber, type, entityId, imageUrl) {
  let caption = '';

  if (type === 'property') {
    const property = await Property.findById(entityId);
    caption = 
      `✅ *Property Added*  \n━━━━━━━━━━━━━━━\n` +
      `📌 *ID*: ${property.property_id}\n` +
      `🏠 *Name*: ${property.name}\n` +
      `📍 *Address*: ${property.address}, ${property.city}\n` +
      `🗺️ *State/ZIP*: ${property.state} - ${property.zipcode}\n` +
      `🌎 *Country*: ${property.country}\n` +
      (property.owner_name ? `👤 *Owner*: ${property.owner_name}\n` : '') +
      (property.owner_contact ? `☎️ *Owner Contact*: ${property.owner_contact}\n` : '') +
      (property.totalAmount ? `💰 *Total Amount*: ${property.totalAmount}\n` : '') +
      `━━━━━━━━━━━━━━━`;
  }
  else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('property');
    caption =
      `✅ *Unit Added*\n━━━━━━━━━━━━━━━\n` +
      `📌 *ID*: ${unit.unit_id}\n` +
      `🏠 *Property*: ${unit.property.name}\n` +
      `🚪 *UnitNumber*: ${unit.unitNumber}\n` +
      `📏 *Floor*: ${unit.floor}\n` +
      `📐 *Size*: ${unit.size}\n` +
      `💰 *Rent*: ${unit.rentAmount}\n` +
      (unit.deposit ? `💵 *Deposit*: ${unit.deposit}\n` : '') +
      `👀 *Status*: ${unit.status}\n` +
      `━━━━━━━━━━━━━━━`;
  }
  else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId).populate('unitAssigned');
    caption =
      `✅ *Tenant Added*\n━━━━━━━━━━━━━━━\n` +
      `📌 *ID*: ${tenant.tenant_id}\n` +
      `👤 *Name*: ${tenant.name}\n` +
      (tenant.email ? `✉️ *Email*: ${tenant.email}\n` : '') +
      `📱 *Phone*: ${tenant.phoneNumber}\n` +
      `🏠 *Property*: ${tenant.propertyName}\n` +
      `🚪 *Unit*: ${tenant.unitAssigned ? tenant.unitAssigned.unitNumber : 'N/A'}\n` +
      `📅 *Lease Start*: ${tenant.lease_start}\n` +
      (tenant.lease_end ? `📅 *Lease End*: ${tenant.lease_end}\n` : '') +
      `💵 *Deposit*: ${tenant.deposit}\n` +
      `💰 *Rent*: ${tenant.rent_amount}\n` +
      `👀 *Status*: ${tenant.status}\n` +
      `━━━━━━━━━━━━━━━`;
  }

  // Try sending as an image first
  await sendImageMessage(phoneNumber, imageUrl, caption);
  // Also send a plain text message for clarity
  await sendMessage(phoneNumber, caption);
}

/** 
 * Send "Would you like to upload an image?" (Yes/No) 
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
        text: `📸 Add Image to ${type}`,
      },
      body: { text: `Would you like to upload an image for this ${type}?` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `upload_${type}_${entityId}`, title: 'Yes' } },
          { type: 'reply', reply: { id: `no_upload_${type}_${entityId}`, title: 'No' } },
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
 * Some basic validators (adjust as needed).
 */
function isValidName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 50;
}
function isValidAddress(addr) {
  return typeof addr === 'string' && addr.trim().length > 0 && addr.length <= 80;
}
function isValidCity(city) {
  return typeof city === 'string' && city.trim().length > 0 && city.length <= 50;
}
function isValidState(st) {
  return typeof st === 'string' && st.trim().length > 0 && st.length <= 50;
}
function isValidZipcode(z) {
  // Simple check – you can refine as needed
  return typeof z === 'string' && z.trim().length > 2 && z.length <= 10;
}
function isValidCountry(country) {
  return typeof country === 'string' && country.trim().length > 0 && country.length <= 50;
}
function isValidNumber(numStr) {
  const val = parseFloat(numStr);
  return !isNaN(val) && val >= 0;
}
function isValidDate(dateStr) {
  // e.g. "DD-MM-YYYY"
  const regex = /^(\d{2})-(\d{2})-(\d{4})$/;
  if (!regex.test(dateStr)) return false;
  const [day, month, year] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return (date.getDate() === day && date.getMonth() === month - 1 && date.getFullYear() === year);
}

/**
 * GET - For WhatsApp webhook verification
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
 * POST - Main Webhook Handler
 */
router.post('/', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    // 1) Save contact info
    if (value.contacts) {
      const contact = value.contacts[0];
      const contactPhoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile.name;
      const user = (await User.findOne({ phoneNumber: contactPhoneNumber }))
        || new User({ phoneNumber: contactPhoneNumber });
      user.profileName = profileName || user.profileName;
      await user.save();
    }

    // 2) Process incoming messages
    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;             // e.g. '918885305097'
      const phoneNumber = `+${fromNumber}`;        // e.g. '+918885305097'
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      console.log(`Message from ${fromNumber}:`, { text, interactive });

      // Capture any interactive replies (buttons/lists)
      if (interactive && interactive.type === 'list_reply') {
        userResponses[fromNumber] = interactive.list_reply.id;
      } 
      else if (interactive && interactive.type === 'button_reply') {
        userResponses[fromNumber] = interactive.button_reply.id;
      }

      // Make sure we have a session object
      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      /*************************************************
       *       ADD PROPERTY FLOW 
       *************************************************/
      if (text) {
        // Step 1: property name
        if (sessions[fromNumber].action === 'add_property_name') {
          if (isValidName(text)) {
            // store property name
            sessions[fromNumber].propertyData = { name: text };
            await sendMessage(fromNumber, '📍 *Property Address*\nPlease enter the street address (e.g., "123 Main St").');
            sessions[fromNumber].action = 'add_property_address';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid name. Please try again.');
          }
        }
        // Step 2: address
        else if (sessions[fromNumber].action === 'add_property_address') {
          if (isValidAddress(text)) {
            sessions[fromNumber].propertyData.address = text;
            await sendMessage(fromNumber, '🌆 *City*\nEnter the city name.');
            sessions[fromNumber].action = 'add_property_city';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid address. Please try again.');
          }
        }
        // Step 3: city
        else if (sessions[fromNumber].action === 'add_property_city') {
          if (isValidCity(text)) {
            sessions[fromNumber].propertyData.city = text;
            await sendMessage(fromNumber, '🏙️ *State*\nEnter the state/province name.');
            sessions[fromNumber].action = 'add_property_state';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid city. Please try again.');
          }
        }
        // Step 4: state
        else if (sessions[fromNumber].action === 'add_property_state') {
          if (isValidState(text)) {
            sessions[fromNumber].propertyData.state = text;
            await sendMessage(fromNumber, '📮 *ZIP/Postal Code*\nEnter the ZIP/Postal code.');
            sessions[fromNumber].action = 'add_property_zipcode';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid state. Please try again.');
          }
        }
        // Step 5: zip
        else if (sessions[fromNumber].action === 'add_property_zipcode') {
          if (isValidZipcode(text)) {
            sessions[fromNumber].propertyData.zipcode = text;
            await sendMessage(fromNumber, '🌎 *Country*\nEnter the country name.');
            sessions[fromNumber].action = 'add_property_country';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid ZIP code. Please try again.');
          }
        }
        // Step 6: country
        else if (sessions[fromNumber].action === 'add_property_country') {
          if (isValidCountry(text)) {
            sessions[fromNumber].propertyData.country = text;
            await sendMessage(fromNumber, '💰 *Total Amount*\nEnter the total amount for this property (e.g., 5000).');
            sessions[fromNumber].action = 'add_property_totalAmount';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid country. Please try again.');
          }
        }
        // Step 7: total amount (optional)
        else if (sessions[fromNumber].action === 'add_property_totalAmount') {
          if (isValidNumber(text)) {
            sessions[fromNumber].propertyData.totalAmount = parseFloat(text);
          } else {
            // not mandatory – if user typed something not numeric, just set 0 or skip
            sessions[fromNumber].propertyData.totalAmount = 0;
          }
          // Now create the property
          const user = await User.findOne({ phoneNumber });
          const propertyDoc = new Property({
            property_id: generatePropertyId(),
            name: sessions[fromNumber].propertyData.name,
            address: sessions[fromNumber].propertyData.address,
            city: sessions[fromNumber].propertyData.city,
            state: sessions[fromNumber].propertyData.state,
            zipcode: sessions[fromNumber].propertyData.zipcode,
            country: sessions[fromNumber].propertyData.country,
            totalAmount: sessions[fromNumber].propertyData.totalAmount,
            userId: user._id,
          });
          await propertyDoc.save();

          // Move on to uploading an image or skipping
          sessions[fromNumber].entityType = 'property';
          sessions[fromNumber].entityId = propertyDoc._id;
          await sendImageOption(fromNumber, 'property', propertyDoc._id);
          sessions[fromNumber].action = 'awaiting_image_choice';
        }

        /*************************************************
         *       ADD UNIT FLOW 
         *************************************************/
        else if (sessions[fromNumber].action === 'add_unit_rent') {
          if (isValidNumber(text)) {
            sessions[fromNumber].unitData.rentAmount = parseFloat(text);
            await sendMessage(fromNumber, '💵 *Deposit*\nEnter the deposit for this unit (e.g., 1000).');
            sessions[fromNumber].action = 'add_unit_deposit';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid rent. Please enter a number.');
          }
        }
        else if (sessions[fromNumber].action === 'add_unit_deposit') {
          // deposit not strictly required – parse or default to 0
          if (isValidNumber(text)) {
            sessions[fromNumber].unitData.deposit = parseFloat(text);
          } else {
            sessions[fromNumber].unitData.deposit = 0;
          }
          await sendMessage(fromNumber, '📏 *Floor*\nEnter the floor (e.g., "Ground", "1st", etc.).');
          sessions[fromNumber].action = 'add_unit_floor';
        }
        else if (sessions[fromNumber].action === 'add_unit_floor') {
          sessions[fromNumber].unitData.floor = text;
          await sendMessage(fromNumber, '📐 *Size*\nEnter the size (e.g., "500 sq ft").');
          sessions[fromNumber].action = 'add_unit_size';
        }
        else if (sessions[fromNumber].action === 'add_unit_size') {
          sessions[fromNumber].unitData.size = text;
          // Now create the unit
          const user = await User.findOne({ phoneNumber });
          const unitDoc = new Unit({
            unit_id: generateUnitId(),
            property: sessions[fromNumber].unitData.property,
            unitNumber: sessions[fromNumber].unitData.unitNumber, // auto-generated label
            rentAmount: sessions[fromNumber].unitData.rentAmount,
            deposit: sessions[fromNumber].unitData.deposit || 0,
            floor: sessions[fromNumber].unitData.floor,
            size: sessions[fromNumber].unitData.size,
            status: 'Vacant',
            userId: user._id,
          });
          await unitDoc.save();

          // Also link the unit to its property (Property.units[])
          const propDoc = await Property.findById(unitDoc.property);
          if (propDoc) {
            propDoc.units.push(unitDoc._id);
            await propDoc.save();
          }

          // Move on to image upload or skip
          sessions[fromNumber].entityType = 'unit';
          sessions[fromNumber].entityId = unitDoc._id;
          await sendImageOption(fromNumber, 'unit', unitDoc._id);
          sessions[fromNumber].action = 'awaiting_image_choice';
        }

        /*************************************************
         *       ADD TENANT FLOW 
         *************************************************/
        else if (sessions[fromNumber].action === 'add_tenant_name') {
          if (isValidName(text)) {
            sessions[fromNumber].tenantData.name = text;
            await sendMessage(fromNumber, '✉️ *Tenant Email (optional)* \nEnter the tenant’s email, or type "skip".');
            sessions[fromNumber].action = 'add_tenant_email';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid tenant name. Please try again.');
          }
        }
        else if (sessions[fromNumber].action === 'add_tenant_email') {
          if (text.toLowerCase() === 'skip') {
            sessions[fromNumber].tenantData.email = '';
          } else {
            // minimal email check – you can refine as needed
            sessions[fromNumber].tenantData.email = text;
          }
          await sendMessage(fromNumber, '📅 *Lease Start Date*\nEnter in DD-MM-YYYY (e.g., 01-01-2025).');
          sessions[fromNumber].action = 'add_tenant_lease_start';
        }
        else if (sessions[fromNumber].action === 'add_tenant_lease_start') {
          if (isValidDate(text)) {
            sessions[fromNumber].tenantData.lease_start = text;
            await sendMessage(fromNumber, '💵 *Deposit*\nEnter the deposit (e.g., 1500).');
            sessions[fromNumber].action = 'add_tenant_deposit';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid date. Please try again (DD-MM-YYYY).');
          }
        }
        else if (sessions[fromNumber].action === 'add_tenant_deposit') {
          if (isValidNumber(text)) {
            sessions[fromNumber].tenantData.deposit = parseFloat(text);
            await sendMessage(fromNumber, '💰 *Rent*\nEnter the monthly rent (e.g., 500).');
            sessions[fromNumber].action = 'add_tenant_rent';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid number. Please enter something like "1500".');
          }
        }
        else if (sessions[fromNumber].action === 'add_tenant_rent') {
          if (isValidNumber(text)) {
            sessions[fromNumber].tenantData.rent_amount = parseFloat(text);
            // Now create the tenant
            const user = await User.findOne({ phoneNumber });
            const tenantDoc = new Tenant({
              tenant_id: generateTenantId(),
              name: sessions[fromNumber].tenantData.name,
              phoneNumber: user.phoneNumber, // or prompt user if different
              email: sessions[fromNumber].tenantData.email,
              unitAssigned: sessions[fromNumber].tenantData.unitAssigned, // stored earlier
              propertyName: sessions[fromNumber].tenantData.propertyName, 
              lease_start: sessions[fromNumber].tenantData.lease_start,
              deposit: sessions[fromNumber].tenantData.deposit,
              rent_amount: sessions[fromNumber].tenantData.rent_amount,
              status: 'Active',
              userId: user._id,
            });
            await tenantDoc.save();

            // Also link the tenant in the Unit (optional if you want to store the occupant)
            const unitDoc = await Unit.findById(tenantDoc.unitAssigned);
            if (unitDoc) {
              unitDoc.tenant = tenantDoc._id;
              unitDoc.status = 'Occupied'; 
              await unitDoc.save();
            }

            // Move on to image upload or skip
            sessions[fromNumber].entityType = 'tenant';
            sessions[fromNumber].entityId = tenantDoc._id;
            await sendImageOption(fromNumber, 'tenant', tenantDoc._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid number. Please try again.');
          }
        }
        // "help" triggers main menu, etc. 
        else if (text.toLowerCase() === 'help') {
          // Show top-level menu
          const buttonMenu = {
            messaging_product: 'whatsapp',
            to: fromNumber,
            type: 'interactive',
            interactive: {
              type: 'button',
              header: { type: 'text', text: '🏠 Rental Management' },
              body: { text: 'Welcome! Please select an option below:' },
              action: {
                buttons: [
                  { type: 'reply', reply: { id: 'account_info', title: '👤 Account Info' } },
                  { type: 'reply', reply: { id: 'manage', title: '🛠️ Manage' } },
                  { type: 'reply', reply: { id: 'tools', title: '🧰 Tools' } },
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

      // 3) Handle any interactive replies
      if (interactive && userResponses[fromNumber]) {
        const selectedOption = userResponses[fromNumber];

        if (selectedOption === 'account_info') {
          const user = await User.findOne({ phoneNumber });
          if (user) {
            const infoMsg = 
              `👤 *Account Info*\n` +
              `Phone: ${user.phoneNumber}\n` +
              `Name: ${user.profileName || 'N/A'}\n` +
              `Verified: ${user.verified ? 'Yes' : 'No'}\n` +
              `Subscription: ${user.subscription}\n`;
            await sendMessage(fromNumber, infoMsg);
          } else {
            await sendMessage(fromNumber, 'No account info found.');
          }
        }
        else if (selectedOption === 'manage') {
          await sendManageSubmenu(fromNumber);
        }
        else if (selectedOption === 'tools') {
          await sendToolsSubmenu(fromNumber);
        }
        else if (selectedOption === 'manage_properties') {
          await sendPropertyOptions(fromNumber);
        }
        else if (selectedOption === 'manage_units') {
          await sendUnitOptions(fromNumber);
        }
        else if (selectedOption === 'manage_tenants') {
          await sendTenantOptions(fromNumber);
        }
        // ===== Add Property (button)
        else if (selectedOption === 'add_property') {
          await sendMessage(fromNumber, '🏠 *Add Property*\nEnter the property name.');
          sessions[fromNumber].action = 'add_property_name';
        }
        // ===== Add Unit (button)
        else if (selectedOption === 'add_unit') {
          // First, we list all properties for user to select
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(fromNumber, 'No properties found. Please add a property first.');
          } else {
            sessions[fromNumber].properties = properties;
            await sendPropertySelectionMenu(fromNumber, properties);
            sessions[fromNumber].action = 'add_unit_select_property';
          }
        }
        // ===== Add Tenant (button)
        else if (selectedOption === 'add_tenant') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(fromNumber, 'No properties found. Please add a property first.');
          } else {
            sessions[fromNumber].properties = properties;
            await sendPropertySelectionMenu(fromNumber, properties);
            sessions[fromNumber].action = 'add_tenant_select_property';
          }
        }
        // ===== If user selected a property from an interactive list to add a unit
        else if (sessions[fromNumber].action === 'add_unit_select_property' && selectedOption.startsWith('chunk')) {
          const [chunkTag, propertyId] = selectedOption.split('_');
          const foundProperty = await Property.findById(propertyId);
          if (foundProperty) {
            sessions[fromNumber].unitData = {};
            sessions[fromNumber].unitData.property = foundProperty._id;
            // Our "unitNumber" is just a label, while "unit_id" is the unique ID
            sessions[fromNumber].unitData.unitNumber = generateUnitId(); 
            await sendMessage(fromNumber, `Unit label generated: ${sessions[fromNumber].unitData.unitNumber}.\n` +
              '💰 *Rent Amount*\nEnter the monthly rent (e.g., 500).');
            sessions[fromNumber].action = 'add_unit_rent';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid selection. Please try again.');
          }
        }
        // ===== If user selected a property from an interactive list to add a tenant
        else if (sessions[fromNumber].action === 'add_tenant_select_property' && selectedOption.startsWith('chunk')) {
          const [chunkTag, propertyId] = selectedOption.split('_');
          const foundProperty = await Property.findById(propertyId);
          if (foundProperty) {
            sessions[fromNumber].tenantData = {};
            sessions[fromNumber].tenantData.propertyName = foundProperty.name;
            // Next, let user select which unit
            const units = await Unit.find({ property: foundProperty._id });
            if (!units.length) {
              await sendMessage(fromNumber, 'No units found in that property. Please add a unit first.');
              sessions[fromNumber].action = null;
              return;
            }
            await sendUnitSelectionMenu(fromNumber, units);
            sessions[fromNumber].action = 'add_tenant_select_unit';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid selection. Please try again.');
          }
        }
        // ===== If user selected a unit from an interactive list to assign a tenant
        else if (sessions[fromNumber].action === 'add_tenant_select_unit' && selectedOption.startsWith('chunk')) {
          const [chunkTag, unitId] = selectedOption.split('_');
          const foundUnit = await Unit.findById(unitId).populate('property');
          if (foundUnit) {
            sessions[fromNumber].tenantData.unitAssigned = foundUnit._id;
            sessions[fromNumber].tenantData.propertyName = foundUnit.property.name;
            // Now continue the tenant flow
            await sendMessage(fromNumber, '👤 *Tenant Name*\nEnter the tenant’s name.');
            sessions[fromNumber].action = 'add_tenant_name';
          } else {
            await sendMessage(fromNumber, '⚠️ Invalid selection. Please try again.');
          }
        }
        // ===== Image Upload choice
        else if (sessions[fromNumber].action === 'awaiting_image_choice') {
          if (selectedOption.startsWith('upload_')) {
            const [, type, entityId] = selectedOption.split('_');
            const token = await generateUploadToken(phoneNumber, type, entityId);
            const uploadUrl = `${GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${entityId}?token=${token}`;
            // Possibly shorten the link
            await sendMessage(fromNumber, `Please upload the image using this link (valid 15 mins):\n${uploadUrl}`);
            sessions[fromNumber].action = null;
          } 
          else if (selectedOption.startsWith('no_upload_')) {
            const [, type, entityId] = selectedOption.split('_');
            // If skipping image, store a placeholder, then send summary
            if (type === 'property') {
              const p = await Property.findById(entityId);
              if (p) {
                // Or push a placeholder Image doc if needed
                await sendSummary(fromNumber, 'property', entityId, DEFAULT_IMAGE_URL);
              }
            } else if (type === 'unit') {
              const u = await Unit.findById(entityId);
              if (u) {
                await sendSummary(fromNumber, 'unit', entityId, DEFAULT_IMAGE_URL);
              }
            } else if (type === 'tenant') {
              const t = await Tenant.findById(entityId);
              if (t) {
                await sendSummary(fromNumber, 'tenant', entityId, DEFAULT_IMAGE_URL);
              }
            }
            sessions[fromNumber].action = null;
          }
        }

        delete userResponses[fromNumber]; // clear user response
      }
    }
  }
  res.sendStatus(200);
});

/**
 * Send chunked interactive-list messages for properties (max 10 per chunk)
 */
async function sendPropertySelectionMenu(phoneNumber, properties) {
  const chunks = chunkArray(properties, 10);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const sectionTitle = `Properties ${i + 1}/${chunks.length}`;
    const rows = chunk.map((prop) => ({
      id: `chunk${i}_${prop._id}`, 
      title: prop.name.slice(0, 24),
      description: (prop.address || '').slice(0, 72),
    }));

    const listMenu = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '🏠 Select a Property' },
        body: {
          text: 
            chunks.length > 1
              ? `Showing chunk ${i + 1}/${chunks.length} of your properties.`
              : 'Please choose a property:',
        },
        footer: { text: `Chunk ${i + 1}/${chunks.length}` },
        action: {
          button: 'Select',
          sections: [
            {
              title: sectionTitle,
              rows: rows,
            },
          ],
        },
      },
    };

    try {
      await axios.post(WHATSAPP_API_URL, listMenu, {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      console.error('Error sending property chunk list:', err.response?.data || err);
      // Fallback to text
      let fallbackMsg = `🏠 *Select a Property (Chunk ${i + 1}/${chunks.length})*\n`;
      chunk.forEach((p, index) => {
        fallbackMsg += `${index + 1}. ${p.name} - ${p.address}\n`;
      });
      await sendMessage(phoneNumber, fallbackMsg);
    }
  }
}

/**
 * Send chunked interactive-list messages for units (max 10 per chunk)
 */
async function sendUnitSelectionMenu(phoneNumber, units) {
  const chunks = chunkArray(units, 10);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const sectionTitle = `Units ${i + 1}/${chunks.length}`;
    const rows = chunk.map((u) => ({
      id: `chunk${i}_${u._id}`,
      title: u.unitNumber.slice(0, 24),
      description: `Floor: ${u.floor}`.slice(0, 72),
    }));

    const listMenu = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '🚪 Select a Unit' },
        body: {
          text: 
            chunks.length > 1
              ? `Showing chunk ${i + 1}/${chunks.length} of your units.`
              : 'Please choose a unit:',
        },
        footer: { text: `Chunk ${i + 1}/${chunks.length}` },
        action: {
          button: 'Select',
          sections: [
            {
              title: sectionTitle,
              rows: rows,
            },
          ],
        },
      },
    };

    try {
      await axios.post(WHATSAPP_API_URL, listMenu, {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      console.error('Error sending unit chunk list:', err.response?.data || err);
      // Fallback to text
      let fallbackMsg = `🚪 *Select a Unit (Chunk ${i + 1}/${chunks.length})*\n`;
      chunk.forEach((u, index) => {
        fallbackMsg += `${index + 1}. ${u.unitNumber} - Floor: ${u.floor}\n`;
      });
      await sendMessage(phoneNumber, fallbackMsg);
    }
  }
}

/** 
 * Submenu for "Manage" 
 */
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
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

/** 
 * Submenu for "Tools" 
 */
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
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

/** 
 * Submenu for "Manage Properties" 
 */
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
          // ... you can add more property-related actions
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
 * Submenu for "Manage Units" 
 */
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
          // ... more actions as needed
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
 * Submenu for "Manage Tenants" 
 */
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
          // ... more actions as needed
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

module.exports = {
  router,
  sendMessage,
  sendSummary,
};
