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
const Image = require('../models/Image');

// WhatsApp Cloud API
const WHATSAPP_API_URL = 'https://graph.facebook.com/v16.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;

// Default placeholder image if user chooses “No”
const DEFAULT_IMAGE_URL = 'https://via.placeholder.com/150';

// Simple in-memory session
const sessions = {};
let userResponses = {};

const router = express.Router();

/* ---------------------------------------------------
   1) Helper: Send a plain text message
--------------------------------------------------- */
async function sendMessage(phoneNumber, text) {
  try {
    await axios.post(
      WHATSAPP_API_URL,
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
    console.error('Error sending WhatsApp text:', err.response?.data || err.message);
  }
}

/* ---------------------------------------------------
   2) Helper: Send an image message (with optional caption)
--------------------------------------------------- */
async function sendImageMessage(phoneNumber, imageUrl, caption = '') {
  try {
    await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'image',
        image: { link: imageUrl, caption },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('Error sending image message:', err.response?.data || err.message);
  }
}

/* ---------------------------------------------------
   3) Generate Upload Token
--------------------------------------------------- */
async function generateUploadToken(phoneNumber, type, entityId) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins
  const doc = new UploadToken({
    token,
    phoneNumber,
    type,
    entityId,
    expiresAt,
  });
  await doc.save();
  return token;
}

/* ---------------------------------------------------
   4) ID Generators
--------------------------------------------------- */
function generateTenantId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `T${digits}${letter}`;
}
function generateUnitId() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `U${digits}${letter}`;
}

/* ---------------------------------------------------
   5) Summaries (send an image from R2, then text)
--------------------------------------------------- */
async function sendSummary(phoneNumber, type, entityId) {
  if (type === 'property') {
    const property = await Property.findById(entityId).populate('images');
    // Get first image or fallback
    let firstImageUrl = DEFAULT_IMAGE_URL;
    if (property.images?.length) {
      const firstImgDoc = await Image.findById(property.images[0]);
      if (firstImgDoc && firstImgDoc.imageUrl) {
        firstImageUrl = firstImgDoc.imageUrl;
      }
    }
    // Send image
    await sendImageMessage(phoneNumber, firstImageUrl);
    // Send text summary
    const msg = `Property Created\n\nName: ${property.name}\nAddress: ${property.address}\nUnits: ${property.units}\nTotal Amount: ${property.totalAmount}`;
    await sendMessage(phoneNumber, msg);

  } else if (type === 'unit') {
    const unit = await Unit.findById(entityId).populate('images property');
    let firstImageUrl = DEFAULT_IMAGE_URL;
    if (unit.images?.length) {
      const firstImgDoc = await Image.findById(unit.images[0]);
      if (firstImgDoc && firstImgDoc.imageUrl) {
        firstImageUrl = firstImgDoc.imageUrl;
      }
    }
    await sendImageMessage(phoneNumber, firstImageUrl);
    const msg = `Unit Created\n\nUnit ID: ${unit.unitNumber}\nProperty: ${unit.property?.name}\nRent: ${unit.rentAmount}\nFloor: ${unit.floor}\nSize: ${unit.size}`;
    await sendMessage(phoneNumber, msg);

  } else if (type === 'tenant') {
    const tenant = await Tenant.findById(entityId).populate('unitAssigned');
    let photoUrl = tenant.photo || DEFAULT_IMAGE_URL;
    await sendImageMessage(phoneNumber, photoUrl);
    const msg = `Tenant Created\n\nName: ${tenant.name}\nTenant ID: ${tenant.tenant_id}\nProperty: ${tenant.propertyName}\nUnit: ${tenant.unitAssigned?.unitNumber}\nLease Start: ${tenant.lease_start}\nDeposit: ${tenant.deposit}\nRent: ${tenant.rent_amount}`;
    await sendMessage(phoneNumber, msg);
  }
}

/* ---------------------------------------------------
   6) Validation
--------------------------------------------------- */
function isValidName(name) {
  const regex = /^[a-zA-Z0-9 ]+$/;
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 40 && regex.test(name);
}
function isValidAddress(addr) {
  const regex = /^[a-zA-Z0-9 ]+$/;
  return typeof addr === 'string' && addr.trim().length > 0 && addr.length <= 40 && regex.test(addr);
}
function isValidUnits(u) {
  const num = parseInt(u, 10);
  return !isNaN(num) && num > 0;
}
function isValidTotalAmount(a) {
  const num = parseFloat(a);
  return !isNaN(num) && num > 0;
}
function isValidDate(dateStr) {
  const regex = /^(\d{2})-(\d{2})-(\d{4})$/;
  if (!regex.test(dateStr)) return false;
  const [day, month, year] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return d.getDate() === day && d.getMonth() === (month - 1) && d.getFullYear() === year;
}

/* ---------------------------------------------------
   7) Interactive Buttons for Menus
--------------------------------------------------- */
async function sendMainMenu(phoneNumber) {
  // For example: Manage, Tools, Account Info
  const menu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Main Menu' },
      body: { text: 'Please select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'account_info', title: 'Account Info' } },
          { type: 'reply', reply: { id: 'manage', title: 'Manage' } },
          { type: 'reply', reply: { id: 'tools', title: 'Tools' } },
        ],
      },
    },
  };
  try {
    await axios.post(WHATSAPP_API_URL, menu, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Error sending main menu:', err.response?.data || err.message);
  }
}

async function sendManageSubmenu(phoneNumber) {
  const menu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Manage Options' },
      body: { text: 'What would you like to manage?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'manage_properties', title: 'Properties' } },
          { type: 'reply', reply: { id: 'manage_units', title: 'Units' } },
          { type: 'reply', reply: { id: 'manage_tenants', title: 'Tenants' } },
        ],
      },
    },
  };
  try {
    await axios.post(WHATSAPP_API_URL, menu, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Error sending manage submenu:', err.response?.data || err.message);
  }
}

async function sendPropertyOptions(phoneNumber) {
  const menu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Property Management' },
      body: { text: 'Select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_property', title: 'Add Property' } },
        ],
      },
    },
  };
  try {
    await axios.post(WHATSAPP_API_URL, menu, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Error sending property options:', err.response?.data || err.message);
  }
}

async function sendUnitOptions(phoneNumber) {
  const menu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Unit Management' },
      body: { text: 'Select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_unit', title: 'Add Unit' } },
        ],
      },
    },
  };
  try {
    await axios.post(WHATSAPP_API_URL, menu, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Error sending unit options:', err.response?.data || err.message);
  }
}

async function sendTenantOptions(phoneNumber) {
  const menu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Tenant Management' },
      body: { text: 'Select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_tenant', title: 'Add Tenant' } },
        ],
      },
    },
  };
  try {
    await axios.post(WHATSAPP_API_URL, menu, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Error sending tenant options:', err.response?.data || err.message);
  }
}

async function sendToolsSubmenu(phoneNumber) {
  // Example Tools submenu
  const menu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Tools' },
      body: { text: 'Select a tool:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'reports', title: 'Reports' } },
          { type: 'reply', reply: { id: 'maintenance', title: 'Maintenance' } },
        ],
      },
    },
  };
  try {
    await axios.post(WHATSAPP_API_URL, menu, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Error sending tools submenu:', err.response?.data || err.message);
  }
}

/* ---------------------------------------------------
   8) Interactive or Numbered List for Properties/Units
--------------------------------------------------- */
async function sendPropertySelection(phoneNumber, properties, nextAction) {
  if (!properties.length) {
    await sendMessage(phoneNumber, 'No properties found. Please add one first.');
    return;
  }
  if (properties.length <= 10) {
    // Interactive list
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
        body: { text: 'Choose one:' },
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
    } catch (err) {
      console.error('Error sending property list:', err.response?.data || err.message);
    }
    sessions[phoneNumber].action = nextAction; 
  } else {
    // Numbered list
    let msg = 'Select a Property (reply with number):\n\n';
    properties.forEach((p, i) => {
      msg += `${i + 1}. ${p.name}\n   ${p.address}\n\n`;
    });
    msg += 'Example: reply "1" to pick the first.';
    await sendMessage(phoneNumber, msg);
    sessions[phoneNumber].action = `${nextAction}_numbered`;
  }
  sessions[phoneNumber].properties = properties;
}

async function sendUnitSelection(phoneNumber, units, nextAction) {
  if (!units.length) {
    await sendMessage(phoneNumber, 'No units found. Please add one first.');
    return;
  }
  if (units.length <= 10) {
    // Interactive list
    const rows = units.map(u => ({
      id: u._id.toString(),
      title: u.unitNumber,
      description: `Rent: ${u.rentAmount}, Floor: ${u.floor}`,
    }));
    const listMenu = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Select a Unit' },
        body: { text: 'Choose one:' },
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
    } catch (err) {
      console.error('Error sending unit list:', err.response?.data || err.message);
    }
    sessions[phoneNumber].action = nextAction;
  } else {
    // Numbered list
    let msg = 'Select a Unit (reply with number):\n\n';
    units.forEach((u, i) => {
      msg += `${i + 1}. ${u.unitNumber} (Rent: ${u.rentAmount}, Floor: ${u.floor})\n\n`;
    });
    msg += 'Example: reply "1" to pick the first.';
    await sendMessage(phoneNumber, msg);
    sessions[phoneNumber].action = `${nextAction}_numbered`;
  }
  sessions[phoneNumber].units = units;
}

/* ---------------------------------------------------
   9) Send "Upload Image?" Buttons
--------------------------------------------------- */
async function sendImageOption(phoneNumber, type, entityId) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: `Add Image to ${type}?` },
      body: { text: 'Would you like to upload an image now?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `upload_${type}_${entityId}`, title: 'Yes' } },
          { type: 'reply', reply: { id: `no_upload_${type}_${entityId}`, title: 'No' } },
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
  } catch (err) {
    console.error('Error sending image option:', err.response?.data || err.message);
  }
}

/* ---------------------------------------------------
   10) The Webhook Endpoints
--------------------------------------------------- */
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
    const entry = body.entry?.[0];
    const changes = entry.changes?.[0];
    const value = changes.value;

    // Save contact info
    if (value.contacts) {
      const contact = value.contacts[0];
      const contactPhoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile?.name;

      let user = await User.findOne({ phoneNumber: contactPhoneNumber });
      if (!user) {
        user = new User({ phoneNumber: contactPhoneNumber, profileName, verified: false });
        await user.save();
      } else if (profileName && user.profileName !== profileName) {
        user.profileName = profileName;
        await user.save();
      }
    }

    // Handle messages
    if (value.messages) {
      const msg = value.messages[0];
      const fromNumber = msg.from;
      const phoneNumber = `+${fromNumber}`;
      const text = msg.text ? msg.text.body.trim() : null;
      const interactive = msg.interactive || null;

      // Capture interactive replies
      if (interactive) {
        if (interactive.type === 'list_reply') {
          userResponses[fromNumber] = interactive.list_reply.id;
        } else if (interactive.type === 'button_reply') {
          userResponses[fromNumber] = interactive.button_reply.id;
        }
      }

      // Set up session
      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      // ------------- MAIN MENU & SUBMENUS -------------
      if (text && text.toLowerCase() === 'menu') {
        // If user types "menu", show main menu
        await sendMainMenu(phoneNumber);
        sessions[fromNumber].action = 'main_menu';
      }

      if (interactive && userResponses[fromNumber]) {
        const selectedOption = userResponses[fromNumber];

        // MAIN MENU
        if (selectedOption === 'account_info') {
          const user = await User.findOne({ phoneNumber });
          if (user) {
            const info = `Account Info\n\nPhone: ${user.phoneNumber}\nName: ${user.profileName || 'N/A'}\nVerified: ${user.verified ? 'Yes' : 'No'}`;
            await sendMessage(phoneNumber, info);
          } else {
            await sendMessage(phoneNumber, 'No account found.');
          }
        } else if (selectedOption === 'manage') {
          await sendManageSubmenu(phoneNumber);
        } else if (selectedOption === 'tools') {
          await sendToolsSubmenu(phoneNumber);
        }

        // MANAGE SUBMENU
        else if (selectedOption === 'manage_properties') {
          await sendPropertyOptions(phoneNumber);
        } else if (selectedOption === 'manage_units') {
          await sendUnitOptions(phoneNumber);
        } else if (selectedOption === 'manage_tenants') {
          await sendTenantOptions(phoneNumber);
        }

        // PROPERTY OPTIONS
        else if (selectedOption === 'add_property') {
          await sendMessage(phoneNumber, 'Enter Property Name:');
          sessions[fromNumber].action = 'add_property_name';
        }

        // UNIT OPTIONS
        else if (selectedOption === 'add_unit') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(phoneNumber, 'No properties found. Please add a property first.');
          } else {
            await sendPropertySelection(phoneNumber, properties, 'select_property_for_unit');
          }
        }

        // TENANT OPTIONS
        else if (selectedOption === 'add_tenant') {
          const user = await User.findOne({ phoneNumber });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(phoneNumber, 'No properties found. Please add a property first.');
          } else {
            await sendPropertySelection(phoneNumber, properties, 'select_property_for_tenant');
          }
        }

        // IMAGE CHOICE
        else if (sessions[fromNumber].action === 'awaiting_image_choice') {
          if (selectedOption.startsWith('upload_')) {
            const [_, type, entityId] = selectedOption.split('_');
            const token = await generateUploadToken(phoneNumber, type, entityId);
            const uploadLink = `${GLITCH_HOST}/upload-image/${phoneNumber}/${type}/${entityId}?token=${token}`;
            await sendMessage(phoneNumber, `Upload your image here (valid for 15 minutes): ${uploadLink}`);

            // Show partial summary now (they can re-check after upload)
            await sendSummary(phoneNumber, type, entityId);
          } else if (selectedOption.startsWith('no_upload_')) {
            const [_, type, entityId] = selectedOption.split('_');
            if (type === 'property') {
              const property = await Property.findById(entityId);
              property.images = [];
              await property.save();
            } else if (type === 'unit') {
              const unit = await Unit.findById(entityId);
              unit.images = [];
              await unit.save();
            } else if (type === 'tenant') {
              const tenant = await Tenant.findById(entityId);
              tenant.photo = DEFAULT_IMAGE_URL;
              await tenant.save();
            }
            await sendSummary(phoneNumber, type, entityId);
          }
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].entityType;
          delete sessions[fromNumber].entityId;
        }
      }

      // ------------- PROPERTY CREATION FLOW -------------
      if (sessions[fromNumber].action === 'add_property_name' && text) {
        if (isValidName(text)) {
          sessions[fromNumber].propertyData = { name: text };
          await sendMessage(phoneNumber, 'Enter Property Address:');
          sessions[fromNumber].action = 'add_property_address';
        } else {
          await sendMessage(phoneNumber, 'Invalid name. Use letters, digits, spaces (max 40 chars).');
        }
      } else if (sessions[fromNumber].action === 'add_property_address' && text) {
        if (isValidAddress(text)) {
          sessions[fromNumber].propertyData.address = text;
          await sendMessage(phoneNumber, 'How many units does this property have?');
          sessions[fromNumber].action = 'add_property_units';
        } else {
          await sendMessage(phoneNumber, 'Invalid address. Letters/digits/spaces, max 40 chars.');
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
          await sendImageOption(phoneNumber, 'property', property._id);
          sessions[fromNumber].action = 'awaiting_image_choice';
        } else {
          await sendMessage(phoneNumber, 'Invalid total amount. Must be a positive number.');
        }
      }

      // ------------- UNIT CREATION FLOW -------------
      // 1) property selection (interactive)
      if (sessions[fromNumber].action === 'select_property_for_unit' && interactive) {
        const selected = userResponses[fromNumber];
        const props = sessions[fromNumber].properties || [];
        const chosen = props.find(p => p._id.toString() === selected);
        if (chosen) {
          sessions[fromNumber].unitData = { property: chosen._id };
          await sendMessage(phoneNumber, 'Enter Rent Amount for this new unit:');
          sessions[fromNumber].action = 'add_unit_rent';
        } else {
          await sendMessage(phoneNumber, 'Invalid property choice.');
        }
      }
      // 2) property selection (numbered)
      if (sessions[fromNumber].action === 'select_property_for_unit_numbered' && text) {
        const choice = parseInt(text, 10);
        const props = sessions[fromNumber].properties || [];
        if (!isNaN(choice) && choice >= 1 && choice <= props.length) {
          const chosen = props[choice - 1];
          sessions[fromNumber].unitData = { property: chosen._id };
          await sendMessage(phoneNumber, 'Enter Rent Amount for this new unit:');
          sessions[fromNumber].action = 'add_unit_rent';
        } else {
          await sendMessage(phoneNumber, 'Invalid choice. Please reply with a valid number.');
        }
      }
      // 3) gather other details
      if (sessions[fromNumber].action === 'add_unit_rent' && text) {
        sessions[fromNumber].unitData.rentAmount = parseFloat(text);
        await sendMessage(phoneNumber, 'Enter Floor (e.g. 1, 2, Ground):');
        sessions[fromNumber].action = 'add_unit_floor';
      } else if (sessions[fromNumber].action === 'add_unit_floor' && text) {
        sessions[fromNumber].unitData.floor = text;
        await sendMessage(phoneNumber, 'Enter Size (e.g. 500 sq ft):');
        sessions[fromNumber].action = 'add_unit_size';
      } else if (sessions[fromNumber].action === 'add_unit_size' && text) {
        const user = await User.findOne({ phoneNumber });
        const unitId = generateUnitId(); 
        const unit = new Unit({
          property: sessions[fromNumber].unitData.property,
          unitNumber: unitId, // auto-generated
          rentAmount: sessions[fromNumber].unitData.rentAmount,
          floor: sessions[fromNumber].unitData.floor,
          size: text,
          userId: user._id,
        });
        await unit.save();

        sessions[fromNumber].entityType = 'unit';
        sessions[fromNumber].entityId = unit._id;
        await sendImageOption(phoneNumber, 'unit', unit._id);
        sessions[fromNumber].action = 'awaiting_image_choice';
      }

      // ------------- TENANT CREATION FLOW -------------
      // 1) property selection
      if (sessions[fromNumber].action === 'select_property_for_tenant' && interactive) {
        const selected = userResponses[fromNumber];
        const props = sessions[fromNumber].properties || [];
        const chosen = props.find(p => p._id.toString() === selected);
        if (chosen) {
          sessions[fromNumber].tenantData = { propertyId: chosen._id, propertyName: chosen.name };
          // Next, pick a unit
          const units = await Unit.find({ property: chosen._id });
          if (!units.length) {
            await sendMessage(phoneNumber, 'No units found in this property. Please add one first.');
            sessions[fromNumber].action = null;
          } else {
            await sendUnitSelection(phoneNumber, units, 'select_unit_for_tenant');
          }
        } else {
          await sendMessage(phoneNumber, 'Invalid property choice.');
        }
      }
      if (sessions[fromNumber].action === 'select_property_for_tenant_numbered' && text) {
        const choice = parseInt(text, 10);
        const props = sessions[fromNumber].properties || [];
        if (!isNaN(choice) && choice >= 1 && choice <= props.length) {
          const chosen = props[choice - 1];
          sessions[fromNumber].tenantData = { propertyId: chosen._id, propertyName: chosen.name };
          const units = await Unit.find({ property: chosen._id });
          if (!units.length) {
            await sendMessage(phoneNumber, 'No units found in this property. Please add one first.');
            sessions[fromNumber].action = null;
          } else {
            await sendUnitSelection(phoneNumber, units, 'select_unit_for_tenant');
          }
        } else {
          await sendMessage(phoneNumber, 'Invalid choice. Please reply with a valid number.');
        }
      }

      // 2) unit selection
      if (sessions[fromNumber].action === 'select_unit_for_tenant' && interactive) {
        const selected = userResponses[fromNumber];
        const units = sessions[fromNumber].units || [];
        const chosen = units.find(u => u._id.toString() === selected);
        if (chosen) {
          sessions[fromNumber].tenantData.unitAssigned = chosen._id;
          await sendMessage(phoneNumber, 'Enter Tenant Name:');
          sessions[fromNumber].action = 'add_tenant_name';
        } else {
          await sendMessage(phoneNumber, 'Invalid unit choice.');
        }
      }
      if (sessions[fromNumber].action === 'select_unit_for_tenant_numbered' && text) {
        const choice = parseInt(text, 10);
        const units = sessions[fromNumber].units || [];
        if (!isNaN(choice) && choice >= 1 && choice <= units.length) {
          const chosen = units[choice - 1];
          sessions[fromNumber].tenantData.unitAssigned = chosen._id;
          await sendMessage(phoneNumber, 'Enter Tenant Name:');
          sessions[fromNumber].action = 'add_tenant_name';
        } else {
          await sendMessage(phoneNumber, 'Invalid choice. Please reply with a valid number.');
        }
      }

      // 3) gather tenant details
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
          await sendMessage(phoneNumber, 'Invalid date. Please use DD-MM-YYYY.');
        }
      } else if (sessions[fromNumber].action === 'add_tenant_deposit' && text) {
        sessions[fromNumber].tenantData.deposit = parseFloat(text);
        await sendMessage(phoneNumber, 'Enter Monthly Rent Amount:');
        sessions[fromNumber].action = 'add_tenant_rent';
      } else if (sessions[fromNumber].action === 'add_tenant_rent' && text) {
        const user = await User.findOne({ phoneNumber });
        const newTenantId = generateTenantId();
        const tenant = new Tenant({
          name: sessions[fromNumber].tenantData.name,
          phoneNumber: user.phoneNumber,
          userId: user._id,
          propertyName: sessions[fromNumber].tenantData.propertyName,
          unitAssigned: sessions[fromNumber].tenantData.unitAssigned,
          lease_start: sessions[fromNumber].tenantData.lease_start,
          deposit: sessions[fromNumber].tenantData.deposit,
          rent_amount: parseFloat(text),
          tenant_id: newTenantId,
        });
        await tenant.save();

        sessions[fromNumber].entityType = 'tenant';
        sessions[fromNumber].entityId = tenant._id;
        await sendImageOption(phoneNumber, 'tenant', tenant._id);
        sessions[fromNumber].action = 'awaiting_image_choice';
      }

      // Clear interactive response
      delete userResponses[fromNumber];
    }
  }

  res.sendStatus(200);
});

module.exports = {
  router,
  sendMessage,
};
