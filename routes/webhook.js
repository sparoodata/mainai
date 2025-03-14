/*********************************
 * routes/webhook.js
 *********************************/

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

// Mongoose Models
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const UploadToken = require('../models/UploadToken');
const Image = require('../models/Image'); // in case we need it

// WhatsApp API Constants
const WHATSAPP_API_URL = 'https://graph.facebook.com/v16.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST || 'https://your-glitch-app.glitch.me';

// Basic fallback image if user says “No upload”
const DEFAULT_IMAGE_URL = 'https://via.placeholder.com/150';

// In-memory session / state
const sessions = {};
let userResponses = {};

// Router
const router = express.Router();

// ------------------------------------------------------
// 1) HELPER FUNCTIONS
// ------------------------------------------------------

/** 
 * Send a plain text message via WhatsApp 
 */
async function sendMessage(phoneNumber, text) {
  try {
    await axios.post(WHATSAPP_API_URL,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('Error sending text message:', err?.response?.data || err.message);
  }
}

/**
 * Send an image message (with optional caption)
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
  } catch (error) {
    console.error('Error sending image message:', error?.response?.data || error.message);
  }
}

/** 
 * Generate an upload token document for image uploads 
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
 * Generate a Tenant ID: T<4 digits><1 capital letter>
 */
function generateTenantId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `T${digits}${letter}`;
}

/**
 * Generate a Unit ID: U<4 digits><1 capital letter>
 */
function generateUnitId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `U${digits}${letter}`;
}

// ------------------------------------------------------
// 2) SENDING LISTS (INTERACTIVE OR NUMBERED)
// ------------------------------------------------------

/**
 * If we have 10 or fewer items, use an Interactive List.
 * Otherwise, use a plain text message with numeric choices.
 */
async function sendPropertySelection(phoneNumber, properties, nextAction) {
  if (properties.length === 0) {
    await sendMessage(phoneNumber, 'No properties found.');
    return;
  }

  if (properties.length <= 10) {
    // Use an interactive list
    const rows = properties.map(p => ({
      id: p._id.toString(),
      title: p.name.slice(0, 24),
      description: p.address.slice(0, 72),
    }));

    const listMenu = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Select a Property' },
        body: { text: 'Choose from the list below:' },
        action: {
          button: 'Pick',
          sections: [
            {
              title: 'Properties',
              rows,
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
    } catch (error) {
      console.error('Error sending interactive list:', error?.response?.data || error.message);
    }
    sessions[phoneNumber].action = nextAction; // e.g. 'add_unit_select_property'
  } else {
    // More than 10 => plain text numbering
    await sendPropertySelectionNumbered(phoneNumber, properties);
    sessions[phoneNumber].action = `${nextAction}_numbered`; 
  }
  // store the properties so we can reference them after user picks
  sessions[phoneNumber].properties = properties;
}

/**
 * Plain text (numbered) for properties
 */
async function sendPropertySelectionNumbered(phoneNumber, properties) {
  let message = `Select a Property by replying with the number:\n\n`;
  properties.forEach((p, i) => {
    message += `${i + 1}. ${p.name}\n   ${p.address}\n\n`;
  });
  message += `Example: reply "1" to choose the first.`;

  await sendMessage(phoneNumber, message);
}

/**
 * Similarly for Units: if <= 10, interactive list; else numbered.
 */
async function sendUnitSelection(phoneNumber, units, nextAction) {
  if (units.length === 0) {
    await sendMessage(phoneNumber, 'No units found for this property.');
    return;
  }

  if (units.length <= 10) {
    // Interactive list
    const rows = units.map(u => ({
      id: u._id.toString(),
      title: u.unitNumber, // or unitId
      description: `Floor: ${u.floor} | Rent: ${u.rentAmount}`,
    }));

    const listMenu = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Select a Unit' },
        body: { text: 'Choose from the list below:' },
        action: {
          button: 'Pick',
          sections: [
            {
              title: 'Units',
              rows,
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
    } catch (error) {
      console.error('Error sending unit list:', error?.response?.data || error.message);
    }
    sessions[phoneNumber].action = nextAction;
  } else {
    // Numbered
    let message = `Select a Unit by replying with the number:\n\n`;
    units.forEach((u, i) => {
      message += `${i + 1}. ${u.unitNumber} (Floor: ${u.floor}, Rent: ${u.rentAmount})\n\n`;
    });
    message += `Example: reply "1" to choose the first.`;

    await sendMessage(phoneNumber, message);
    sessions[phoneNumber].action = `${nextAction}_numbered`;
  }
  sessions[phoneNumber].units = units;
}

// ------------------------------------------------------
// 3) SENDING SUMMARIES
// ------------------------------------------------------

/**
 * Send the final summary. 
 * 1) Send the R2 image (if available), or a default image.
 * 2) Then send text details.
 */
async function sendSummary(phoneNumber, type, entityId) {
  if (type === 'property') {
    const property = await Property.findById(entityId).populate('images');
    // 1) find the first image URL if any
    let firstImageUrl = DEFAULT_IMAGE_URL;
    if (property.images && property.images.length > 0) {
      const firstImageId = property.images[0];
      const imageDoc = await Image.findById(firstImageId);
      if (imageDoc && imageDoc.imageUrl) {
        firstImageUrl = imageDoc.imageUrl;
      }
    }
    // 2) send image
    await sendImageMessage(phoneNumber, firstImageUrl);
    // 3) send text
    let text = `Property Created Successfully!\n\nName: ${property.name}\nAddress: ${property.address}\nUnits: ${property.units}\nTotal Amount: ${property.totalAmount}`;
    await sendMessage(phoneNumber, text);

  } else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('images property');
    let firstImageUrl = DEFAULT_IMAGE_URL;
    if (unit.images && unit.images.length > 0) {
      const firstImageId = unit.images[0];
      const imageDoc = await Image.findById(firstImageId);
      if (imageDoc && imageDoc.imageUrl) {
        firstImageUrl = imageDoc.imageUrl;
      }
    }
    await sendImageMessage(phoneNumber, firstImageUrl);
    let text = `Unit Created Successfully!\n\nUnit ID: ${unit.unitNumber}\nProperty: ${unit.property ? unit.property.name : 'N/A'}\nRent: ${unit.rentAmount}\nFloor: ${unit.floor}\nSize: ${unit.size}`;
    await sendMessage(phoneNumber, text);

  } else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId).populate('unitAssigned');
    let firstImageUrl = DEFAULT_IMAGE_URL;
    if (tenant.photo) {
      firstImageUrl = tenant.photo;
    }
    await sendImageMessage(phoneNumber, firstImageUrl);
    let text = `Tenant Created Successfully!\n\nName: ${tenant.name}\nTenant ID: ${tenant.tenant_id}\nProperty: ${tenant.propertyName}\nUnit: ${
      tenant.unitAssigned ? tenant.unitAssigned.unitNumber : 'N/A'
    }\nLease Start: ${tenant.lease_start}\nDeposit: ${tenant.deposit}\nRent: ${tenant.rent_amount}`;
    await sendMessage(phoneNumber, text);
  }
}

// ------------------------------------------------------
// 4) VALIDATIONS
// ------------------------------------------------------

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

// ------------------------------------------------------
// 5) WEBHOOK ROUTES
// ------------------------------------------------------

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

    // 1) If there's contact info, store in DB
    if (value.contacts) {
      const contact = value.contacts[0];
      const contactPhoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile.name;

      const user = await User.findOne({ phoneNumber: contactPhoneNumber });
      if (user) {
        if (profileName && user.profileName !== profileName) {
          user.profileName = profileName;
          await user.save();
        }
      } else {
        const newUser = new User({
          phoneNumber: contactPhoneNumber,
          profileName,
          verified: false,
        });
        await newUser.save();
      }
    }

    // 2) If there's a message, process it
    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;
      const phoneNumber = `+${fromNumber}`;
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      // Track user responses
      if (interactive && interactive.type === 'list_reply') {
        userResponses[fromNumber] = interactive.list_reply.id;
      } else if (interactive && interactive.type === 'button_reply') {
        userResponses[fromNumber] = interactive.button_reply.id;
      }

      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      // ----------------------------------------------------------------
      // EXAMPLE: If user types "help", show main menu (you can adapt)
      // ----------------------------------------------------------------
      if (text && text.toLowerCase() === 'help') {
        await sendMessage(phoneNumber, 'Main Menu:\n\n1) Manage Properties\n2) Manage Units\n3) Manage Tenants\n\nReply "1", "2", or "3" to proceed.');
        sessions[fromNumber].action = 'main_menu_numbered';
      }

      // Handle "main_menu_numbered" (example if user has typed "help" and sees a numeric list)
      if (sessions[fromNumber].action === 'main_menu_numbered' && text) {
        if (text === '1') {
          // manage properties
          await sendMessage(phoneNumber, 'Property Menu:\n\n1) Add Property\n\nReply with "1" to add a property.');
          sessions[fromNumber].action = 'property_menu_numbered';
        } else if (text === '2') {
          // manage units
          await sendMessage(phoneNumber, 'Unit Menu:\n\n1) Add Unit\n\nReply with "1" to add a unit.');
          sessions[fromNumber].action = 'unit_menu_numbered';
        } else if (text === '3') {
          // manage tenants
          await sendMessage(phoneNumber, 'Tenant Menu:\n\n1) Add Tenant\n\nReply with "1" to add a tenant.');
          sessions[fromNumber].action = 'tenant_menu_numbered';
        } else {
          await sendMessage(phoneNumber, 'Invalid choice. Please reply "1", "2", or "3".');
        }
      }

      // PROPERTY MENU
      if (sessions[fromNumber].action === 'property_menu_numbered' && text) {
        if (text === '1') {
          // add property
          await sendMessage(phoneNumber, 'Enter Property Name:');
          sessions[fromNumber].action = 'add_property_name';
        } else {
          await sendMessage(phoneNumber, 'Invalid choice.');
        }
      }

      // UNIT MENU
      if (sessions[fromNumber].action === 'unit_menu_numbered' && text) {
        if (text === '1') {
          // add unit
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(phoneNumber, 'No properties found. Add a property first.');
            sessions[fromNumber].action = null;
          } else {
            // Show property selection (interactive or numbered)
            await sendPropertySelection(phoneNumber, properties, 'add_unit_select_property');
          }
        } else {
          await sendMessage(phoneNumber, 'Invalid choice.');
        }
      }

      // TENANT MENU
      if (sessions[fromNumber].action === 'tenant_menu_numbered' && text) {
        if (text === '1') {
          // add tenant
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(phoneNumber, 'No properties found. Add a property first.');
            sessions[fromNumber].action = null;
          } else {
            await sendPropertySelection(phoneNumber, properties, 'add_tenant_select_property');
          }
        } else {
          await sendMessage(phoneNumber, 'Invalid choice.');
        }
      }

      // ----------------------------------------------------------------
      // PROPERTY FLOW
      // ----------------------------------------------------------------
      if (sessions[fromNumber].action === 'add_property_name' && text) {
        if (isValidName(text)) {
          sessions[fromNumber].propertyData = { name: text };
          await sendMessage(phoneNumber, 'Enter Property Address:');
          sessions[fromNumber].action = 'add_property_address';
        } else {
          await sendMessage(phoneNumber, 'Invalid name. Use only letters/numbers/spaces, up to 40 chars.');
        }
      } else if (sessions[fromNumber].action === 'add_property_address' && text) {
        if (isValidAddress(text)) {
          sessions[fromNumber].propertyData.address = text;
          await sendMessage(phoneNumber, 'How many units does this property have?');
          sessions[fromNumber].action = 'add_property_units';
        } else {
          await sendMessage(phoneNumber, 'Invalid address. Letters/numbers/spaces, up to 40 chars.');
        }
      } else if (sessions[fromNumber].action === 'add_property_units' && text) {
        if (isValidUnits(text)) {
          sessions[fromNumber].propertyData.units = parseInt(text, 10);
          await sendMessage(phoneNumber, 'What is the total amount for this property?');
          sessions[fromNumber].action = 'add_property_totalAmount';
        } else {
          await sendMessage(phoneNumber, 'Invalid number of units. Must be a positive integer.');
        }
      } else if (sessions[fromNumber].action === 'add_property_totalAmount' && text) {
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

          // Prompt for image
          sessions[fromNumber].entityType = 'property';
          sessions[fromNumber].entityId = property._id;
          await sendImageChoice(phoneNumber, 'property', property._id);
          sessions[fromNumber].action = 'awaiting_image_choice';
        } else {
          await sendMessage(phoneNumber, 'Invalid total amount. Must be a positive number.');
        }
      }

      // ----------------------------------------------------------------
      // UNIT FLOW
      // ----------------------------------------------------------------

      // Interactive or numbered property selection for adding a unit
      if (sessions[fromNumber].action === 'add_unit_select_property' && interactive) {
        const selectedOption = userResponses[fromNumber];
        const properties = sessions[fromNumber].properties || [];
        const selectedProperty = properties.find(p => p._id.toString() === selectedOption);
        if (selectedProperty) {
          // Create a new unit with auto-generated ID
          sessions[fromNumber].unitData = { property: selectedProperty._id };
          await sendMessage(phoneNumber, 'Enter Rent Amount for this Unit:');
          sessions[fromNumber].action = 'add_unit_rent';
        } else {
          await sendMessage(phoneNumber, 'Invalid property selection.');
        }
      } else if (sessions[fromNumber].action === 'add_unit_select_property_numbered' && text) {
        // user typed a number
        const choice = parseInt(text, 10);
        const properties = sessions[fromNumber].properties || [];
        if (!isNaN(choice) && choice >= 1 && choice <= properties.length) {
          const selectedProperty = properties[choice - 1];
          sessions[fromNumber].unitData = { property: selectedProperty._id };
          await sendMessage(phoneNumber, 'Enter Rent Amount for this Unit:');
          sessions[fromNumber].action = 'add_unit_rent';
        } else {
          await sendMessage(phoneNumber, 'Invalid choice. Please enter a valid number.');
        }
      } else if (sessions[fromNumber].action === 'add_unit_rent' && text) {
        sessions[fromNumber].unitData.rentAmount = parseFloat(text);
        await sendMessage(phoneNumber, 'Enter Floor (e.g. 1, 2, Ground, etc.):');
        sessions[fromNumber].action = 'add_unit_floor';
      } else if (sessions[fromNumber].action === 'add_unit_floor' && text) {
        sessions[fromNumber].unitData.floor = text;
        await sendMessage(phoneNumber, 'Enter Size (e.g. 500 sq ft):');
        sessions[fromNumber].action = 'add_unit_size';
      } else if (sessions[fromNumber].action === 'add_unit_size' && text) {
        const user = await User.findOne({ phoneNumber });
        const unitId = generateUnitId();
        const newUnit = new Unit({
          property: sessions[fromNumber].unitData.property,
          unitNumber: unitId, // or rename field to "unitId" in your model
          rentAmount: sessions[fromNumber].unitData.rentAmount,
          floor: sessions[fromNumber].unitData.floor,
          size: text,
          userId: user._id,
        });
        await newUnit.save();

        sessions[fromNumber].entityType = 'unit';
        sessions[fromNumber].entityId = newUnit._id;
        await sendImageChoice(phoneNumber, 'unit', newUnit._id);
        sessions[fromNumber].action = 'awaiting_image_choice';
      }

      // ----------------------------------------------------------------
      // TENANT FLOW
      // ----------------------------------------------------------------

      // property selection
      if (sessions[fromNumber].action === 'add_tenant_select_property' && interactive) {
        const selectedOption = userResponses[fromNumber];
        const properties = sessions[fromNumber].properties || [];
        const selectedProperty = properties.find(p => p._id.toString() === selectedOption);
        if (selectedProperty) {
          sessions[fromNumber].tenantData = { propertyId: selectedProperty._id, propertyName: selectedProperty.name };
          // Now we pick a unit from that property
          const units = await Unit.find({ property: selectedProperty._id });
          if (!units.length) {
            await sendMessage(phoneNumber, 'No units in this property. Add a unit first.');
            sessions[fromNumber].action = null;
          } else {
            await sendUnitSelection(phoneNumber, units, 'add_tenant_select_unit');
          }
        } else {
          await sendMessage(phoneNumber, 'Invalid property selection.');
        }
      } else if (sessions[fromNumber].action === 'add_tenant_select_property_numbered' && text) {
        const choice = parseInt(text, 10);
        const properties = sessions[fromNumber].properties || [];
        if (!isNaN(choice) && choice >= 1 && choice <= properties.length) {
          const selectedProperty = properties[choice - 1];
          sessions[fromNumber].tenantData = { propertyId: selectedProperty._id, propertyName: selectedProperty.name };
          const units = await Unit.find({ property: selectedProperty._id });
          if (!units.length) {
            await sendMessage(phoneNumber, 'No units in this property. Add a unit first.');
            sessions[fromNumber].action = null;
          } else {
            await sendUnitSelection(phoneNumber, units, 'add_tenant_select_unit');
          }
        } else {
          await sendMessage(phoneNumber, 'Invalid choice. Please enter a valid number.');
        }
      }

      // unit selection
      if (sessions[fromNumber].action === 'add_tenant_select_unit' && interactive) {
        const selectedOption = userResponses[fromNumber];
        const units = sessions[fromNumber].units || [];
        const selectedUnit = units.find(u => u._id.toString() === selectedOption);
        if (selectedUnit) {
          sessions[fromNumber].tenantData.unitAssigned = selectedUnit._id;
          await sendMessage(phoneNumber, 'Enter Tenant Name:');
          sessions[fromNumber].action = 'add_tenant_name';
        } else {
          await sendMessage(phoneNumber, 'Invalid unit selection.');
        }
      } else if (sessions[fromNumber].action === 'add_tenant_select_unit_numbered' && text) {
        const choice = parseInt(text, 10);
        const units = sessions[fromNumber].units || [];
        if (!isNaN(choice) && choice >= 1 && choice <= units.length) {
          const selectedUnit = units[choice - 1];
          sessions[fromNumber].tenantData.unitAssigned = selectedUnit._id;
          await sendMessage(phoneNumber, 'Enter Tenant Name:');
          sessions[fromNumber].action = 'add_tenant_name';
        } else {
          await sendMessage(phoneNumber, 'Invalid choice. Please enter a valid number.');
        }
      }

      // continue tenant flow
      if (sessions[fromNumber].action === 'add_tenant_name' && text) {
        sessions[fromNumber].tenantData.name = text;
        await sendMessage(phoneNumber, 'Enter Lease Start Date (DD-MM-YYYY):');
        sessions[fromNumber].action = 'add_tenant_lease_start';
      } else if (sessions[fromNumber].action === 'add_tenant_lease_start' && text) {
        if (isValidDate(text)) {
          sessions[fromNumber].tenantData.lease_start = text;
          await sendMessage(phoneNumber, 'Enter Deposit Amount:');
          sessions[fromNumber].action = 'add_tenant_deposit';
        } else {
          await sendMessage(phoneNumber, 'Invalid date format. Use DD-MM-YYYY.');
        }
      } else if (sessions[fromNumber].action === 'add_tenant_deposit' && text) {
        sessions[fromNumber].tenantData.deposit = parseFloat(text);
        await sendMessage(phoneNumber, 'Enter Monthly Rent:');
        sessions[fromNumber].action = 'add_tenant_rent';
      } else if (sessions[fromNumber].action === 'add_tenant_rent' && text) {
        const user = await User.findOne({ phoneNumber });
        const tenantId = generateTenantId();
        const tenant = new Tenant({
          name: sessions[fromNumber].tenantData.name,
          phoneNumber: user.phoneNumber,
          userId: user._id,
          propertyName: sessions[fromNumber].tenantData.propertyName,
          unitAssigned: sessions[fromNumber].tenantData.unitAssigned,
          lease_start: sessions[fromNumber].tenantData.lease_start,
          deposit: sessions[fromNumber].tenantData.deposit,
          rent_amount: parseFloat(text),
          tenant_id: tenantId,
        });
        await tenant.save();

        sessions[fromNumber].entityType = 'tenant';
        sessions[fromNumber].entityId = tenant._id;
        await sendImageChoice(phoneNumber, 'tenant', tenant._id);
        sessions[fromNumber].action = 'awaiting_image_choice';
      }

      // ----------------------------------------------------------------
      // IMAGE CHOICE FLOW
      // ----------------------------------------------------------------
      if (sessions[fromNumber].action === 'awaiting_image_choice' && interactive) {
        const selectedOption = userResponses[fromNumber];
        if (selectedOption.startsWith('upload_')) {
          const [_, type, entityId] = selectedOption.split('_');
          const token = await generateUploadToken(phoneNumber, type, entityId);
          const link = `${GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${entityId}?token=${token}`;
          await sendMessage(phoneNumber, `You can upload an image here (valid 15 mins): ${link}`);

          // Summaries will come after they upload. Or we can show a partial summary now:
          await sendSummary(phoneNumber, type, entityId);

        } else if (selectedOption.startsWith('no_upload_')) {
          const [_, type, entityId] = selectedOption.split('_');
          // If user chooses "No upload," we set a default or do nothing
          if (type === 'property') {
            const property = await Property.findById(entityId);
            if (!property.images) property.images = [];
            property.images = []; // or you could push a default image doc
            await property.save();
            await sendSummary(phoneNumber, 'property', entityId);
          } else if (type === 'unit') {
            const unit = await Unit.findById(entityId);
            if (!unit.images) unit.images = [];
            unit.images = []; 
            await unit.save();
            await sendSummary(phoneNumber, 'unit', entityId);
          } else if (type === 'tenant') {
            const tenant = await Tenant.findById(entityId);
            tenant.photo = DEFAULT_IMAGE_URL; 
            await tenant.save();
            await sendSummary(phoneNumber, 'tenant', entityId);
          }
        }
        sessions[fromNumber].action = null;
        delete sessions[fromNumber].entityType;
        delete sessions[fromNumber].entityId;
      }

      // ----------------------------------------------------------------
      // CLEAR INTERACTIVE RESPONSE
      // ----------------------------------------------------------------
      delete userResponses[fromNumber];
    }
  }

  res.sendStatus(200);
});

// ------------------------------------------------------
// 6) HELPER: Send "Upload or Not" Buttons
// ------------------------------------------------------
async function sendImageChoice(phoneNumber, type, entityId) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: {
        type: 'text',
        text: `Add Image to ${type}?`,
      },
      body: {
        text: `Would you like to upload an image for this ${type}?`,
      },
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
  try {
    await axios.post(WHATSAPP_API_URL, buttonMenu, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error sending image choice:', error?.response?.data || error.message);
  }
}

module.exports = {
  router,
  sendMessage,
};
