/*********************************
 * routes/webhook.js
 *********************************/

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

// === Import Your Mongoose Models ===
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const UploadToken = require('../models/UploadToken');

// (Optional) If you use a specialized library or external service:
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '' });

// === WhatsApp API Constants ===
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;  // e.g. https://your-glitch-app.glitch.me

// Fallback Image if user chooses "no upload"
const DEFAULT_IMAGE_URL = 'https://via.placeholder.com/150';

// === In-Memory Session / State Tracking ===
const sessions = {};
let userResponses = {};

// === Express Router ===
const router = express.Router();

/** 
 * Helper to shorten a URL using TinyURL
 */
async function shortenUrl(longUrl) {
  try {
    const response = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl));
    return response.data;
  } catch (error) {
    console.error('Error shortening URL:', error);
    return longUrl;
  }
}

/** 
 * Generates a token document in your DB so the user can upload an image 
 */
async function generateUploadToken(phoneNumber, type, entityId) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min expiry
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
 * Sends a WhatsApp text message 
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
          'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('Error sending WhatsApp message:', err.response ? err.response.data : err);
  }
}

/**
 * Sends an Image (with optional caption) to the user on WhatsApp
 * e.g. usage: await sendImageMessage('+123456789', 'https://domain.com/image.jpg', 'Your caption here!')
 */
async function sendImageMessage(phoneNumber, imageUrl, caption = '') {
  try {
    await axios.post(WHATSAPP_API_URL,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'image',
        image: {
          link: imageUrl,
          caption: caption
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`Image message sent to ${phoneNumber}`);
  } catch (error) {
    console.error('Error sending image message:', error?.response?.data || error.message);
  }
}

/** 
 * Sends a button-based message letting the user choose to upload or not
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
        text: `📸 Add Image to ${type.charAt(0).toUpperCase() + type.slice(1)}`,
      },
      body: {
        text: `Would you like to upload an image for this ${type}?`,
      },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: {
              id: `upload_${type}_${entityId}`,
              title: 'Yes'
            }
          },
          {
            type: 'reply',
            reply: {
              id: `no_upload_${type}_${entityId}`,
              title: 'No'
            }
          },
        ],
      },
    },
  };
  try {
    await axios.post(WHATSAPP_API_URL, buttonMenu, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error sending button menu:', error.response ? error.response.data : error);
  }
}

/** 
 * Sends a summary message once an entity is created or updated 
 */
async function sendSummary(phoneNumber, type, entityId, imageUrl) {
  let summary;
  if (type === 'property') {
    const property = await Property.findById(entityId);
    summary = `
📸 *Image*: ${imageUrl}
✅ *Property Added*
━━━━━━━━━━━━━━━
🏠 *Name*: ${property.name}
📍 *Address*: ${property.address}
🚪 *Units*: ${property.units}
💰 *Total Amount*: ${property.totalAmount}
━━━━━━━━━━━━━━━
    `;
  } else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('property');
    summary = `
📸 *Image*: ${imageUrl}
✅ *Unit Added*
━━━━━━━━━━━━━━━
🏠 *Property*: ${unit.property.name}
🚪 *Unit Number*: ${unit.unitNumber}
💰 *Rent Amount*: ${unit.rentAmount}
📏 *Floor*: ${unit.floor}
📐 *Size*: ${unit.size}
━━━━━━━━━━━━━━━
    `;
  } else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId);
    const unit = await Unit.findById(tenant.unitAssigned);
    summary = `
📸 *Image*: ${imageUrl}
✅ *Tenant Added*
━━━━━━━━━━━━━━━
👤 *Name*: ${tenant.name}
🏠 *Property*: ${tenant.propertyName}
🚪 *Unit*: ${unit ? unit.unitNumber : 'N/A'}
📅 *Lease Start*: ${tenant.lease_start}
💵 *Deposit*: ${tenant.deposit}
💰 *Rent Amount*: ${tenant.rent_amount}
━━━━━━━━━━━━━━━
    `;
  }
  await sendMessage(phoneNumber, summary);
}

// === Basic Validation Helpers ===
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
  return (
    date.getDate() === day &&
    date.getMonth() === month - 1 &&
    date.getFullYear() === year
  );
}

/**
 * GET for Webhook verification
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
 * POST for handling incoming WhatsApp messages
 */
router.post('/', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    // === Extract contact info / phone number ===
    if (value.contacts) {
      const contact = value.contacts[0];
      const contactPhoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile.name;

      // Check / Create user in DB
      const existingUser = await User.findOne({ phoneNumber: contactPhoneNumber });
      if (existingUser) {
        // Update profile name if changed
        if (profileName && existingUser.profileName !== profileName) {
          existingUser.profileName = profileName;
          await existingUser.save();
        }
      } else {
        const newUser = new User({
          phoneNumber: contactPhoneNumber,
          profileName,
          verified: false, // or true if your logic sets it
        });
        await newUser.save();
      }
    }

    // === Incoming message content ===
    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;
      const phoneNumber = `+${fromNumber}`;
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      console.log(`Message from ${fromNumber}:`, { text, interactive });

      // Store user’s interactive response
      if (interactive && interactive.type === 'list_reply') {
        userResponses[fromNumber] = interactive.list_reply.id;
        console.log(`List reply received: ${userResponses[fromNumber]}`);
      } else if (interactive && interactive.type === 'button_reply') {
        userResponses[fromNumber] = interactive.button_reply.id;
        console.log(`Button reply received: ${userResponses[fromNumber]}`);
      }

      // In-memory session
      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      // === EXAMPLE USAGE: If user types "image test", send an image with a caption
      if (text && text.toLowerCase() === 'image test') {
        await sendImageMessage(
          phoneNumber,
          'https://via.placeholder.com/350x200.png?text=Sample+Image',
          'Hey, this is an example of sending an image with a caption!'
        );
      }

      // === Handle text-based flows ===
      if (text) {
        // 1) Add property flow
        if (sessions[fromNumber].action === 'add_property_name') {
          if (isValidName(text)) {
            sessions[fromNumber].propertyData = { name: text };
            await sendMessage(fromNumber, '📍 *Property Address* \nPlease provide the address of the property.');
            sessions[fromNumber].action = 'add_property_address';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease retry with a valid property name (only alphanumeric and space, max 40 chars).');
          }
        } else if (sessions[fromNumber].action === 'add_property_address') {
          if (isValidAddress(text)) {
            sessions[fromNumber].propertyData.address = text;
            await sendMessage(fromNumber, '🏠 *Number of Units* \nHow many units does this property have? (e.g., 5)');
            sessions[fromNumber].action = 'add_property_units';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease retry with a valid address (only alphanumeric and space, max 40 chars).');
          }
        } else if (sessions[fromNumber].action === 'add_property_units') {
          if (isValidUnits(text)) {
            sessions[fromNumber].propertyData.units = parseInt(text);
            await sendMessage(fromNumber, '💰 *Total Amount* \nWhat is the total amount for this property (e.g., 5000)?');
            sessions[fromNumber].action = 'add_property_totalAmount';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease retry with a valid number of units (positive whole number).');
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

            // Prompt user to upload image
            sessions[fromNumber].entityType = 'property';
            sessions[fromNumber].entityId = property._id;
            await sendImageOption(fromNumber, 'property', property._id);
            sessions[fromNumber].action = 'awaiting_image_choice';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid entry* \nPlease enter a valid total amount (e.g., 5000).');
          }
        }

        // 2) Add unit flow
        else if (sessions[fromNumber].action === 'add_unit_number') {
          sessions[fromNumber].unitData.unitNumber = text;
          await sendMessage(fromNumber, '💰 *Rent Amount* \nWhat is the rent for this unit?');
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

          sessions[fromNumber].entityType = 'unit';
          sessions[fromNumber].entityId = unit._id;
          await sendImageOption(fromNumber, 'unit', unit._id);
          sessions[fromNumber].action = 'awaiting_image_choice';
        }

        // 3) Add tenant flow
        else if (sessions[fromNumber].action === 'add_tenant_name') {
          sessions[fromNumber].tenantData.name = text;
          await sendMessage(fromNumber, '📅 *Lease Start Date* \nWhen does the lease start? (DD-MM-YYYY, e.g. 01-01-2025)');
          sessions[fromNumber].action = 'add_tenant_lease_start';
        } else if (sessions[fromNumber].action === 'add_tenant_lease_start') {
          if (isValidDate(text)) {
            sessions[fromNumber].tenantData.lease_start = text;
            await sendMessage(fromNumber, '💵 *Deposit* \nWhat is the deposit amount?');
            sessions[fromNumber].action = 'add_tenant_deposit';
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Date* \nUse DD-MM-YYYY format, e.g. 01-01-2025.');
          }
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
        }

        // 4) User typed "help"
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
                  { type: 'reply', reply: { id: 'account_info', title: '👤 Account Info' } },
                  { type: 'reply', reply: { id: 'manage', title: '🛠️ Manage' } },
                  { type: 'reply', reply: { id: 'tools', title: '🧰 Tools' } },
                ],
              },
            },
          };
          await axios.post(WHATSAPP_API_URL, buttonMenu, {
            headers: {
              'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          });
        }
      }

      // === Handle Interactive (button/list) flows ===
      if (interactive && userResponses[fromNumber]) {
        const selectedOption = userResponses[fromNumber];
        
        // -- MAIN MENU HANDLERS --
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
💰 *Subscription*: ${user.subscription || 'Free'}
━━━━━━━━━━━━━━━
            `
            : '⚠️ *No Account Found* \nNo account information is available for this number.';
          await sendMessage(fromNumber, accountInfoMessage);
        } else if (selectedOption === 'manage') {
          await sendManageSubmenu(fromNumber);
        } else if (selectedOption === 'tools') {
          await sendToolsSubmenu(fromNumber);
        }

        // -- MANAGE SUBMENU HANDLERS --
        else if (selectedOption === 'manage_properties') {
          await sendPropertyOptions(fromNumber);
        } else if (selectedOption === 'manage_units') {
          await sendUnitOptions(fromNumber);
        } else if (selectedOption === 'manage_tenants') {
          await sendTenantOptions(fromNumber);
        }

        // -- PROPERTY HANDLERS --
        else if (selectedOption === 'add_property') {
          await sendMessage(fromNumber, '🏠 *Add Property* \nLet’s start! Provide the property name.');
          sessions[fromNumber].action = 'add_property_name';
        }

        // -- UNIT HANDLERS --
        else if (selectedOption === 'add_unit') {
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
        } else if (sessions[fromNumber].action === 'add_unit_select_property') {
          const propertyId = selectedOption;
          const properties = sessions[fromNumber].properties || await Property.find({ userId: sessions[fromNumber].userId });
          const selectedProperty = properties.find(p => p._id.toString() === propertyId);

          if (selectedProperty) {
            sessions[fromNumber].unitData = { property: selectedProperty._id };
            const units = await Unit.find({ property: selectedProperty._id });
            if (!units.length) {
              // No units yet, prompt user to create new
              await sendMessage(fromNumber, 'ℹ️ *No Units* \nPlease add a new unit. Enter the unit number:');
              sessions[fromNumber].action = 'add_unit_number';
            } else {
              await sendUnitSelectionMenu(fromNumber, units);
              sessions[fromNumber].action = 'add_unit_select_unit';
            }
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease select a valid property from the menu.');
            await sendPropertySelectionMenu(fromNumber, properties);
          }
        } else if (sessions[fromNumber].action === 'add_unit_select_unit') {
          const unitId = selectedOption;
          const units = await Unit.find({ property: sessions[fromNumber].unitData.property }).populate('property');
          const selectedUnit = units.find(u => u._id.toString() === unitId);

          if (selectedUnit) {
            // If user selects an existing unit, we can decide how to handle. 
            // Example: "That unit already exists; please add a different unit number."
            await sendMessage(fromNumber, 'ℹ️ This unit already exists. To add a new unit, please enter a new unit number.');
            sessions[fromNumber].action = 'add_unit_number';
          } else {
            // If no match, user is effectively creating a new one
            await sendMessage(fromNumber, '🚪 *Unit Number* \nPlease provide the unit number.');
            sessions[fromNumber].action = 'add_unit_number';
          }
        }

        // -- TENANT HANDLERS --
        else if (selectedOption === 'manage_tenants') {
          // Already handled above - if you add more tenant management features, do so here
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
        } else if (sessions[fromNumber].action === 'add_tenant_select_property') {
          const propertyId = selectedOption;
          const properties = sessions[fromNumber].properties || await Property.find({ userId: sessions[fromNumber].userId });
          const selectedProperty = properties.find(p => p._id.toString() === propertyId);

          if (selectedProperty) {
            sessions[fromNumber].tenantData = { propertyId: selectedProperty._id };
            const units = await Unit.find({ property: selectedProperty._id });
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
          const unitId = selectedOption;
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
        }

        // -- IMAGE UPLOAD CHOICE --
        else if (sessions[fromNumber].action === 'awaiting_image_choice') {
          // The format is "upload_type_id" or "no_upload_type_id"
          if (selectedOption.startsWith('upload_')) {
            const [_, type, entityId] = selectedOption.split('_');
            const token = await generateUploadToken(phoneNumber, type, entityId);
            const imageUploadUrl = `${GLITCH_HOST}/upload-image/${fromNumber}/${type}/${entityId}?token=${token}`;
            const shortUrl = await shortenUrl(imageUploadUrl);

            await sendMessage(fromNumber, `Please upload the image here (valid for 15 minutes): ${shortUrl}`);
            await sendSummary(phoneNumber, type, entityId, shortUrl); 
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].entityType;
            delete sessions[fromNumber].entityId;
          } else if (selectedOption.startsWith('no_upload_')) {
            const [_, type, entityId] = selectedOption.split('_');
            if (type === 'property') {
              const property = await Property.findById(entityId);
              property.images = [DEFAULT_IMAGE_URL];
              await property.save();
              await sendSummary(phoneNumber, 'property', entityId, DEFAULT_IMAGE_URL);
            } else if (type === 'unit') {
              const unit = await Unit.findById(entityId);
              unit.images = [DEFAULT_IMAGE_URL];
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
          }
        }

        // Clear the stored user response
        delete userResponses[fromNumber];
      }
    }
  }
  // Let the meta webhook server know we received the request
  res.sendStatus(200);
});

/**
 * Helper to send a property selection menu
 */
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
        sections: [
          {
            title: 'Properties',
            rows: properties.map(p => ({
              id: p._id.toString(),
              title: p.name.slice(0, 24),
              description: p.address.slice(0, 72),
            })),
          },
        ],
      },
    },
  };
  try {
    await axios.post(WHATSAPP_API_URL, listMenu, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error sending property selection menu:', error.response ? error.response.data : error);
  }
}

/**
 * Helper to send a unit selection menu
 */
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
        sections: [
          {
            title: 'Units',
            rows: units.map(u => ({
              id: u._id.toString(),
              title: u.unitNumber.slice(0, 24),
              description: `${u.property.name} - Floor: ${u.floor}`.slice(0, 72),
            })),
          },
        ],
      },
    },
  };
  try {
    await axios.post(WHATSAPP_API_URL, listMenu, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error sending unit selection menu:', error.response ? error.response.data : error);
  }
}

/**
 * Sends the "Manage" submenu with 3 buttons
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
  try {
    await axios.post(WHATSAPP_API_URL, buttonMenu, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error sending manage submenu:', error.response ? error.response.data : error);
  }
}

/**
 * Sends the "Tools" submenu with 3 buttons
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
  try {
    await axios.post(WHATSAPP_API_URL, buttonMenu, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error sending tools submenu:', error.response ? error.response.data : error);
  }
}

/**
 * Sends property management options
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
        ],
      },
    },
  };
  try {
    await axios.post(WHATSAPP_API_URL, buttonMenu, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error sending property options:', error.response ? error.response.data : error);
  }
}

/**
 * Sends unit management options
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
        ],
      },
    },
  };
  try {
    await axios.post(WHATSAPP_API_URL, buttonMenu, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error sending unit options:', error.response ? error.response.data : error);
  }
}

/**
 * Sends tenant management options
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
        ],
      },
    },
  };
  try {
    await axios.post(WHATSAPP_API_URL, buttonMenu, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error sending tenant options:', error.response ? error.response.data : error);
  }
}

/**
 * Generate a random tenant ID (TXXXXA)
 */
function generateTenantId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return 'T' + digits + letter;
}

module.exports = {
  router,
  sendMessage
  // If needed, you can also export sendImageMessage here
};
