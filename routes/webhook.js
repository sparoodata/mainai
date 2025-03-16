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

const sessions = {};
let userResponses = {};

/**
 * Helper to chunk an array into subarrays of up to `size` items each.
 */
function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

// Helper: Check if a string is numeric
function isNumeric(value) {
  return /^-?\d+$/.test(value);
}

// Helper: Generate a Unit ID in format U<4-digit><Caps Letter>
function generateUnitId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return 'U' + digits + letter;
}

// Helper: Generate a Tenant ID in format T<4-digit><Caps Letter>
function generateTenantId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return 'T' + digits + letter;
}

// URL shortener helper
async function shortenUrl(longUrl) {
  try {
    const response = await axios.post(
      'https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl)
    );
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

// Sends a text message via WhatsApp
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

// Sends an image message with caption via WhatsApp
async function sendImageMessage(phoneNumber, imageUrl, caption) {
  try {
    const response = await axios.post(
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
    console.log('Image message sent:', response.data);
  } catch (err) {
    console.error(
      'Error sending WhatsApp image message:',
      err.response ? err.response.data : err
    );
    // Fallback: Send a text message with the summary caption
    await sendMessage(phoneNumber, caption);
  }
}

// Sends a summary message as both an image message (with caption) and a separate text message
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
    caption = `✅ *Tenant Added*\n━━━━━━━━━━━━━━━\n👤 *Name*: ${tenant.name}\n🏠 *Property*: ${tenant.propertyName}\n🚪 *Unit*: ${
      unit ? unit.unitNumber : 'N/A'
    }\n📅 *Lease Start*: ${tenant.lease_start}\n💵 *Deposit*: ${
      tenant.deposit
    }\n💰 *Rent Amount*: ${tenant.rent_amount}\n━━━━━━━━━━━━━━━`;
  }
  // First try to send the image message with caption
  await sendImageMessage(phoneNumber, imageUrl, caption);
  // Also send a text message so the summary is clearly visible
  await sendMessage(phoneNumber, caption);
}

// Sends an interactive image upload option
async function sendImageOption(phoneNumber, type, entityId) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: {
        type: 'text',
        text: `📸 Add Image to ${type.charAt(0).toUpperCase() + type.slice(1)}`,
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

// Basic validation functions
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

    // Capture contact info
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

    // Capture messages
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
        console.log(`List reply received: ${userResponses[fromNumber]}`);
      } else if (interactive && interactive.type === 'button_reply') {
        userResponses[fromNumber] = interactive.button_reply.id;
        console.log(`Button reply received: ${userResponses[fromNumber]}`);
      }

      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      // Handle numeric responses (if we revert to numeric selection flows)
      if (
        text &&
        sessions[fromNumber].action &&
        (sessions[fromNumber].action === 'add_unit_select_property' ||
          sessions[fromNumber].action === 'add_tenant_select_property' ||
          sessions[fromNumber].action === 'add_tenant_select_unit')
      ) {
        // If we used text-based numeric selection, we’d handle it here.
        // Currently, we are using chunked interactive lists, so we might not rely on this.
      }

      // ======== Add-Property Flow ========
      if (text) {
        if (sessions[fromNumber].action === 'add_property_name') {
          if (isValidName(text)) {
            sessions[fromNumber].propertyData = { name: text };
            await sendMessage(
              fromNumber,
              '📍 *Property Address* \nPlease provide the address of the property.'
            );
            sessions[fromNumber].action = 'add_property_address';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease retry with a valid property name (e.g., "Sunset Apartments"). Max 40 characters, no special characters.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_property_address') {
          if (isValidAddress(text)) {
            sessions[fromNumber].propertyData.address = text;
            await sendMessage(
              fromNumber,
              '🏠 *Number of Units* \nHow many units does this property have? (e.g., 5)'
            );
            sessions[fromNumber].action = 'add_property_units';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease retry with a valid address (e.g., "123 Main St"). Max 40 characters, no special characters.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_property_units') {
          if (isValidUnits(text)) {
            sessions[fromNumber].propertyData.units = parseInt(text);
            await sendMessage(
              fromNumber,
              '💰 *Total Amount* \nWhat is the total amount for this property (e.g., 5000)?'
            );
            sessions[fromNumber].action = 'add_property_totalAmount';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease retry with a valid number of units (e.g., 5). Must be a positive whole number.'
            );
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
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease retry with a valid total amount (e.g., 5000). Must be a positive number.'
            );
          }
        }
        // ======== Add-Unit Flow ========
        else if (sessions[fromNumber].action === 'add_unit_rent') {
          const rent = parseFloat(text);
          if (!isNaN(rent) && rent > 0) {
            sessions[fromNumber].unitData.rentAmount = rent;
            await sendMessage(
              fromNumber,
              '📏 *Floor* \nWhich floor is this unit on? (e.g., 1, Ground)'
            );
            sessions[fromNumber].action = 'add_unit_floor';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease provide a valid rent amount.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_unit_floor') {
          sessions[fromNumber].unitData.floor = text;
          await sendMessage(
            fromNumber,
            '📐 *Size* \nWhat is the size of this unit (e.g., 500 sq ft)?'
          );
          sessions[fromNumber].action = 'add_unit_size';
        } else if (sessions[fromNumber].action === 'add_unit_size') {
          const user = await User.findOne({ phoneNumber });
          const unit = new Unit({
            property: sessions[fromNumber].unitData.property,
            unitNumber: sessions[fromNumber].unitData.unitNumber, // auto-generated earlier
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
        }
        // ======== Add-Tenant Flow ========
        else if (sessions[fromNumber].action === 'add_tenant_name') {
          sessions[fromNumber].tenantData.name = text;
          await sendMessage(
            fromNumber,
            '📅 *Lease Start Date* \nWhen does the lease start? (e.g., DD-MM-YYYY like 01-01-2025)'
          );
          sessions[fromNumber].action = 'add_tenant_lease_start';
        } else if (sessions[fromNumber].action === 'add_tenant_lease_start') {
          if (isValidDate(text)) {
            sessions[fromNumber].tenantData.lease_start = text;
            await sendMessage(
              fromNumber,
              '💵 *Deposit* \nWhat is the deposit amount?'
            );
            sessions[fromNumber].action = 'add_tenant_deposit';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid Date* \nPlease use DD-MM-YYYY format (e.g., 01-01-2025).'
            );
          }
        } else if (sessions[fromNumber].action === 'add_tenant_deposit') {
          const deposit = parseFloat(text);
          if (!isNaN(deposit) && deposit > 0) {
            sessions[fromNumber].tenantData.deposit = deposit;
            await sendMessage(
              fromNumber,
              '💰 *Rent Amount* \nWhat is the monthly rent amount?'
            );
            sessions[fromNumber].action = 'add_tenant_rent';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease provide a valid deposit amount.'
            );
          }
        } else if (sessions[fromNumber].action === 'add_tenant_rent') {
          const rent = parseFloat(text);
          if (!isNaN(rent) && rent > 0) {
            const user = await User.findOne({ phoneNumber });
            const tenant = new Tenant({
              name: sessions[fromNumber].tenantData.name,
              phoneNumber: user.phoneNumber,
              userId: user._id,
              propertyName: sessions[fromNumber].tenantData.propertyName,
              unitAssigned: sessions[fromNumber].tenantData.unitAssigned,
              lease_start: sessions[fromNumber].tenantData.lease_start,
              deposit: sessions[fromNumber].tenantData.deposit,
              rent_amount: rent,
              tenant_id: generateTenantId(),
            });
            await tenant.save();
            sessions[fromNumber].entityType = 'tenant';
            sessions[fromNumber].entityId = tenant._id;
            await sendImageOption(fromNumber, 'tenant', tenant._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
          } else {
            await sendMessage(
              fromNumber,
              '⚠️ *Invalid entry* \nPlease provide a valid rent amount.'
            );
          }
        }
        // ========== “Help” Flow ==========
        else if (text.toLowerCase() === 'help') {
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
                  {
                    type: 'reply',
                    reply: { id: 'account_info', title: '👤 Account Info' },
                  },
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

      // Handle interactive replies (button or list)
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
📅 *Registration Date*: ${
                user.registrationDate
                  ? user.registrationDate.toLocaleDateString()
                  : 'N/A'
              }
💰 *Subscription*: ${user.subscription}
━━━━━━━━━━━━━━━
          `
            : '⚠️ *No Account Found* \nNo account information is available for this number.';
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
          await sendMessage(
            fromNumber,
            '🏠 *Add Property* \nLet’s start! Please provide the property name.'
          );
          sessions[fromNumber].action = 'add_property_name';
        } else if (selectedOption === 'add_unit') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(
              fromNumber,
              'ℹ️ *No Properties* \nPlease add a property first.'
            );
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            // Now we send chunked interactive lists of properties:
            await sendPropertySelectionMenu(fromNumber, properties);
            sessions[fromNumber].action = 'add_unit_select_property';
          }
        } else if (selectedOption === 'add_tenant') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(
              fromNumber,
              'ℹ️ *No Properties* \nPlease add a property first.'
            );
          } else {
            sessions[fromNumber].properties = properties;
            sessions[fromNumber].userId = user._id;
            // Now we send chunked interactive lists of properties:
            await sendPropertySelectionMenu(fromNumber, properties);
            sessions[fromNumber].action = 'add_tenant_select_property';
          }
        }
        // Handle property selection from chunked lists (for adding a Unit):
        else if (sessions[fromNumber].action === 'add_unit_select_property') {
          // The incoming selectedOption might look like: "chunk0_<propertyId>"
          if (selectedOption.startsWith('chunk')) {
            // Parse out the propertyId
            const [chunkTag, propertyId] = selectedOption.split('_');
            const foundProperty = await Property.findById(propertyId);
            if (foundProperty) {
              sessions[fromNumber].unitData = { property: foundProperty._id };
              sessions[fromNumber].unitData.unitNumber = generateUnitId();
              await sendMessage(
                fromNumber,
                `Unit ID generated: ${sessions[fromNumber].unitData.unitNumber}. Please provide the rent amount for this unit.`
              );
              sessions[fromNumber].action = 'add_unit_rent';
            } else {
              await sendMessage(
                fromNumber,
                '⚠️ *Invalid Selection* \nPlease select a valid property.'
              );
            }
          }
        }
        // Handle property selection from chunked lists (for adding a Tenant):
        else if (sessions[fromNumber].action === 'add_tenant_select_property') {
          if (selectedOption.startsWith('chunk')) {
            const [chunkTag, propertyId] = selectedOption.split('_');
            const foundProperty = await Property.findById(propertyId);
            if (foundProperty) {
              sessions[fromNumber].tenantData = {
                propertyId: foundProperty._id,
                propertyName: foundProperty.name,
              };
              const units = await Unit.find({ property: foundProperty._id });
              if (!units.length) {
                await sendMessage(
                  fromNumber,
                  'ℹ️ *No Units* \nPlease add a unit to this property first.'
                );
                sessions[fromNumber].action = null;
                delete sessions[fromNumber].tenantData;
              } else {
                await sendUnitSelectionMenu(fromNumber, units);
                sessions[fromNumber].action = 'add_tenant_select_unit';
              }
            } else {
              await sendMessage(
                fromNumber,
                '⚠️ *Invalid Selection* \nPlease select a valid property.'
              );
            }
          }
        }
        // Handle unit selection from chunked lists (for adding a Tenant):
        else if (sessions[fromNumber].action === 'add_tenant_select_unit') {
          if (selectedOption.startsWith('chunk')) {
            const [chunkTag, unitId] = selectedOption.split('_');
            const foundUnit = await Unit.findById(unitId).populate('property');
            if (foundUnit) {
              sessions[fromNumber].tenantData.unitAssigned = foundUnit._id;
              sessions[fromNumber].tenantData.propertyName =
                foundUnit.property.name;
              await sendMessage(
                fromNumber,
                '👤 *Tenant Name* \nPlease provide the tenant’s full name.'
              );
              sessions[fromNumber].action = 'add_tenant_name';
            } else {
              await sendMessage(
                fromNumber,
                '⚠️ *Invalid Selection* \nPlease select a valid unit.'
              );
            }
          }
        }
        // Handle image upload choice
        else if (sessions[fromNumber].action === 'awaiting_image_choice') {
          if (selectedOption.startsWith('upload_')) {
            const [, type, entityId] = selectedOption.split('_');
            const token = await generateUploadToken(phoneNumber, type, entityId);
            const imageUploadUrl = `${GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${entityId}?token=${token}`;
            const shortUrl = await shortenUrl(imageUploadUrl);
            await sendMessage(
              fromNumber,
              `Please upload the image here (valid for 15 minutes): ${shortUrl}`
            );
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].entityType;
            delete sessions[fromNumber].entityId;
          } else if (selectedOption.startsWith('no_upload_')) {
            const [, type, entityId] = selectedOption.split('_');
            if (type === 'property') {
              const property = await Property.findById(entityId);
              property.images.push(DEFAULT_IMAGE_URL);
              await property.save();
              await sendSummary(
                fromNumber,
                'property',
                entityId,
                DEFAULT_IMAGE_URL
              );
            } else if (type === 'unit') {
              const unit = await Unit.findById(entityId);
              unit.images.push(DEFAULT_IMAGE_URL);
              await unit.save();
              await sendSummary(fromNumber, 'unit', entityId, DEFAULT_IMAGE_URL);
            } else if (type === 'tenant') {
              const tenant = await Tenant.findById(entityId);
              tenant.photo = DEFAULT_IMAGE_URL;
              await tenant.save();
              await sendSummary(fromNumber, 'tenant', entityId, DEFAULT_IMAGE_URL);
            }
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].entityType;
            delete sessions[fromNumber].entityId;
          }
        }
        // Clear the user response so it doesn't interfere later
        delete userResponses[fromNumber];
      }
    }
  }
  res.sendStatus(200);
});

/**
 * Sends one or more interactive lists of up to 10 properties each.
 * If `properties.length` > 10, we chunk into multiple messages.
 */
async function sendPropertySelectionMenu(phoneNumber, properties) {
  const chunks = chunkArray(properties, 10);

  // For each chunk, send an interactive list message
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const sectionTitle = `Properties ${i + 1}/${chunks.length}`;

    // Build the rows for this chunk
    const rows = chunk.map((prop) => ({
      // Example row ID: "chunk0_<propertyId>"
      id: `chunk${i}_${prop._id}`,
      title: prop.name.slice(0, 24),
      description: prop.address.slice(0, 72),
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

    // Send the interactive list
    try {
      await axios.post(WHATSAPP_API_URL, listMenu, {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      console.error('Error sending property chunk list:', err.response?.data || err);
      // Fallback: send them as text if needed
      let fallbackMsg = `🏠 *Select a Property (Chunk ${i + 1}/${
        chunks.length
      })*\n`;
      chunk.forEach((p, index) => {
        fallbackMsg += `${index + 1}. ${p.name} - ${p.address}\n`;
      });
      fallbackMsg += '\n[Please pick an item by name or ID]';
      await sendMessage(phoneNumber, fallbackMsg);
    }
  }
}

/**
 * Sends one or more interactive lists of up to 10 units each.
 */
async function sendUnitSelectionMenu(phoneNumber, units) {
  const chunks = chunkArray(units, 10);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const sectionTitle = `Units ${i + 1}/${chunks.length}`;

    // Build the rows for this chunk
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

    // Send the interactive list
    try {
      await axios.post(WHATSAPP_API_URL, listMenu, {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      console.error('Error sending unit chunk list:', err.response?.data || err);
      // Fallback: send them as text if needed
      let fallbackMsg = `🚪 *Select a Unit (Chunk ${i + 1}/${
        chunks.length
      })*\n`;
      chunk.forEach((u, index) => {
        fallbackMsg += `${index + 1}. ${u.unitNumber} - Floor: ${u.floor}\n`;
      });
      fallbackMsg += '\n[Please pick an item by name or ID]';
      await sendMessage(phoneNumber, fallbackMsg);
    }
  }
}

// Submenu for Manage
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
          {
            type: 'reply',
            reply: { id: 'manage_properties', title: '🏠 Properties' },
          },
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

// Submenu for Tools
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

// Property management submenu
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
          // You can add more property-related buttons here as needed...
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

// Unit management submenu
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
          // You can add more unit-related buttons here as needed...
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

// Tenant management submenu
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
          // You can add more tenant-related buttons here as needed...
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
