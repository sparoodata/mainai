// webhook.js
const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Authorize = require('../models/Authorize');
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const router = express.Router();

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;
const { S3Client } = require('@aws-sdk/client-s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Configure R2 client
const AWS = require('aws-sdk');
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});
// Session management to track user interactions
const sessions = {};
let userResponses = {};

// Helper function to shorten URLs
async function shortenUrl(longUrl) {
  try {
    const response = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl));
    return response.data;
  } catch (error) {
    console.error('Error shortening URL:', error.response ? error.response.data : error);
    return longUrl;
  }
}

// Helper function to get Groq AI response
async function getGroqAIResponse(message, phoneNumber, isAssistanceMode) {
  try {
    const systemPrompt = isAssistanceMode
      ? "You are an AI assistant helping a user with commands for a rental management app. Suggest using *Help* to see the menu or assist with their query."
      : "You are an AI agent for a rental management app. If the user needs help with commands, suggest using *Help* to see the menu. Otherwise, respond naturally to the message.";

    const response = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error with Groq AI:', error);
    return '⚠️ *Sorry*, I encountered an error. Please try again or type *Help* for assistance.';
  }
}

// Helper function to send a WhatsApp message (text only)
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

// Helper function to send an image with a caption
async function sendImageMessage(phoneNumber, imageUrl, caption) {
  try {
    await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'image',
      image: {
        link: imageUrl,
        caption: caption,
      },
    }, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`Image message sent to ${phoneNumber} with URL: ${imageUrl}`);
  } catch (err) {
    console.error('Error sending image message:', err.response ? err.response.data : err);
    await sendMessage(phoneNumber, '⚠️ *Error* \nFailed to send image. Here’s the info without the image:\n' + caption);
  }
}

// Webhook verification for WhatsApp API
router.get('/', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified successfully');
      return res.status(200).send(challenge);
    } else {
      console.error('Webhook verification failed');
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// Webhook event handling
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
      console.log(`Profile name received: ${profileName} for phone number: ${contactPhoneNumber}`);

      const user = await User.findOne({ phoneNumber: contactPhoneNumber });
      if (user) {
        if (profileName) {
          user.profileName = profileName;
          await user.save();
          console.log(`Profile name updated to ${profileName} for user ${contactPhoneNumber}`);
        }
      } else {
        console.log(`No user found for phone: ${contactPhoneNumber}`);
      }
    }

    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;
      const phoneNumber = `+${fromNumber}`;
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      if (interactive && interactive.type === 'button_reply') {
        const buttonReplyId = interactive.button_reply.id;
        console.log(`Button reply received: ${buttonReplyId} from ${fromNumber}`);
        userResponses[fromNumber] = buttonReplyId;
      }

      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      console.log(`Received message from ${phoneNumber}: ${text}`);
      console.log(`Current session state for ${fromNumber}: ${JSON.stringify(sessions[fromNumber])}`);

      if (text) {
        console.log(`Processing text input: ${text} for ${fromNumber}`);
        if (sessions[fromNumber].action === 'select_property') {
          console.log(`Property selection received: ${text} from ${fromNumber}`);
          const propertyIndex = parseInt(text) - 1;
          const properties = sessions[fromNumber].properties;

          if (propertyIndex >= 0 && propertyIndex < properties.length) {
            const selectedProperty = properties[propertyIndex];
            console.log(`Selected property: ${selectedProperty.name} (ID: ${selectedProperty._id})`);
            if (sessions[fromNumber].nextAction === 'editunit') {
              await promptUnitSelection(fromNumber, 'editunit', selectedProperty._id);
              sessions[fromNumber].action = 'select_unit_to_edit';
            } else if (sessions[fromNumber].nextAction === 'removeunit') {
              await promptUnitSelection(fromNumber, 'removeunit', selectedProperty._id);
              sessions[fromNumber].action = 'select_unit_to_remove';
            } else if (sessions[fromNumber].nextAction === 'edittenant') {
              await promptTenantSelection(fromNumber, 'edittenant', selectedProperty._id);
              sessions[fromNumber].action = 'select_tenant_to_edit';
            }
            sessions[fromNumber].propertyId = selectedProperty._id;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid property number.');
          }
        } else if (sessions[fromNumber].action === 'select_unit_to_edit') {
          console.log(`Unit selection received: ${text} from ${fromNumber}`);
          const unitIndex = parseInt(text) - 1;
          const units = sessions[fromNumber].units;

          if (unitIndex >= 0 && unitIndex < units.length) {
            const selectedUnit = units[unitIndex];
            console.log(`Selected unit: ${selectedUnit.unitNumber} (ID: ${selectedUnit._id})`);
            await sendPropertyLink(fromNumber, 'editunit', null, sessions[fromNumber].propertyId);
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].propertyId;
            delete sessions[fromNumber].units;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid unit number.');
          }
        } else if (sessions[fromNumber].action === 'select_unit_to_remove') {
          console.log(`Unit to remove selection received: ${text} from ${fromNumber}`);
          const unitIndex = parseInt(text) - 1;
          const units = sessions[fromNumber].units;

          if (unitIndex >= 0 && unitIndex < units.length) {
            const selectedUnit = units[unitIndex];
            console.log(`Selected unit to remove: ${selectedUnit.unitNumber} (ID: ${selectedUnit._id})`);
            await confirmUnitRemoval(fromNumber, selectedUnit);
            sessions[fromNumber].action = 'confirm_unit_removal';
            sessions[fromNumber].unitToRemove = selectedUnit;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid unit number.');
          }
        } else if (sessions[fromNumber].action === 'select_tenant_to_edit') {
          console.log(`Tenant selection received: ${text} from ${fromNumber}`);
          const tenantIndex = parseInt(text) - 1;
          const tenants = sessions[fromNumber].tenants;

          if (tenantIndex >= 0 && tenantIndex < tenants.length) {
            const selectedTenant = tenants[tenantIndex];
            console.log(`Selected tenant: ${selectedTenant.name} (ID: ${selectedTenant._id})`);
            await sendPropertyLink(fromNumber, 'edittenant', selectedTenant._id);
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].propertyId;
            delete sessions[fromNumber].tenants;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid tenant number.');
          }
        } else if (sessions[fromNumber].action === 'select_property_to_remove') {
          // ... (unchanged)
        } else if (sessions[fromNumber].action === 'select_tenant_to_remove') {
          // ... (unchanged)
        } else if (sessions[fromNumber].action === 'rent_paid') {
          // ... (unchanged)
        } else if (sessions[fromNumber].action === 'select_property_for_info') {
          // ... (unchanged)
        } else if (sessions[fromNumber].action === 'select_unit_for_info') {
          // ... (unchanged)
        } else if (sessions[fromNumber].action === 'select_tenant_for_info') {
          // ... (unchanged)
        } else if (text.toLowerCase() === 'help') {
          // ... (unchanged)
        } else if (text.startsWith('\\')) {
          // ... (unchanged)
        } else if (!sessions[fromNumber].action) {
          // ... (unchanged)
        }
      }

      if (interactive) {
        const selectedOption = interactive.button_reply.id;

        if (sessions[fromNumber].action === 'confirm_unit_removal' && selectedOption === 'yes_remove_unit') {
          const unit = sessions[fromNumber].unitToRemove;
          try {
            await Unit.findByIdAndDelete(unit._id);
            await sendMessage(fromNumber, `✅ *Success* \nUnit *${unit.unitNumber}* has been deleted successfully!`);
            console.log(`Unit ${unit._id} deleted`);
          } catch (error) {
            console.error(`Error deleting unit ${unit._id}:`, error);
            await sendMessage(fromNumber, `❌ *Error* \nFailed to delete unit *${unit.unitNumber}*. Please try again.`);
          }
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].unitToRemove;
        } else if (sessions[fromNumber].action === 'confirm_unit_removal' && selectedOption === 'no_remove_unit') {
          await sendMessage(fromNumber, `ℹ️ *Canceled* \nRemoval of unit *${sessions[fromNumber].unitToRemove.unitNumber}* has been canceled.`);
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].unitToRemove;
        } else if (sessions[fromNumber].action === 'confirm_property_removal' && selectedOption === 'yes_remove_property') {
          // ... (unchanged)
        } else if (sessions[fromNumber].action === 'confirm_property_removal' && selectedOption === 'no_remove_property') {
          // ... (unchanged)
        } else if (sessions[fromNumber].action === 'confirm_tenant_removal' && selectedOption === 'yes_remove_tenant') {
          // ... (unchanged)
        } else if (sessions[fromNumber].action === 'confirm_tenant_removal' && selectedOption === 'no_remove_tenant') {
          // ... (unchanged)
        } else if (selectedOption === 'account_info') {
          // ... (unchanged)
        } else if (selectedOption === 'rent_paid') {
          // ... (unchanged)
        } else if (selectedOption === 'manage') {
          // ... (unchanged)
        } else if (selectedOption === 'tools') {
          // ... (unchanged)
        } else if (selectedOption === 'reports') {
          // ... (unchanged)
        } else if (selectedOption === 'maintenance') {
          // ... (unchanged)
        } else if (selectedOption === 'info') {
          // ... (unchanged)
        } else if (selectedOption === 'property_info') {
          // ... (unchanged)
        } else if (selectedOption === 'unit_info') {
          // ... (unchanged)
        } else if (selectedOption === 'tenant_info') {
          // ... (unchanged)
        } else if (selectedOption === 'financial_summary') {
          // ... (unchanged)
        } else if (selectedOption === 'occupancy_report') {
          // ... (unchanged)
        } else if (selectedOption === 'maintenance_trends') {
          // ... (unchanged)
        } else if (selectedOption === 'manage_properties') {
          // ... (unchanged)
        } else if (selectedOption === 'manage_units') {
          // ... (unchanged)
        } else if (selectedOption === 'manage_tenants') {
          // ... (unchanged)
        } else if (selectedOption === 'add_property') {
          // ... (unchanged)
        } else if (selectedOption === 'edit_property') {
          // ... (unchanged)
        } else if (selectedOption === 'remove_property') {
          // ... (unchanged)
        } else if (selectedOption === 'add_unit') {
          // ... (unchanged)
        } else if (selectedOption === 'edit_unit') {
          console.log(`Edit Unit selected by ${fromNumber}`);
          await promptPropertySelection(fromNumber, 'editunit');
        } else if (selectedOption === 'remove_unit') {
          console.log(`Remove Unit selected by ${fromNumber}`);
          await promptPropertySelection(fromNumber, 'removeunit');
        } else if (selectedOption === 'add_tenant') {
          // ... (unchanged)
        } else if (selectedOption === 'edit_tenant') {
          // ... (unchanged)
        } else if (selectedOption === 'remove_tenant') {
          // ... (unchanged)
        }
      }
    }
  } else {
    return res.sendStatus(404);
  }

  res.sendStatus(200);
});

// Helper function to prompt unit selection
async function promptUnitSelection(phoneNumber, action, propertyId) {
  console.log(`Prompting unit selection for property ${propertyId} for ${phoneNumber}`);
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const units = await Unit.find({ property: propertyId });
  if (!units.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Units Found* \nNo units are assigned to this property.');
    return;
  }

  let unitList = `*🚪 Select a Unit to ${action === 'editunit' ? 'Edit' : 'Remove'}* \nReply with the number of the unit:\n━━━━━━━━━━━━━━━\n`;
  units.forEach((unit, index) => {
    unitList += `${index + 1}. *${unit.unitNumber}* \n   _Rent_: $${unit.rentAmount}\n`;
  });
  unitList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, unitList);
  console.log(`Unit list sent to ${phoneNumber}: ${unitList}`);

  sessions[phoneNumber].units = units;
}
// Helper function to wait for the user response (polling every second)
async function waitForUserResponse(phoneNumber, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const intervalId = setInterval(() => {
      if (userResponses[phoneNumber]) {
        const response = userResponses[phoneNumber];
        clearInterval(intervalId);
        console.log(`Captured user response: ${response} from ${phoneNumber}`);
        delete userResponses[phoneNumber];
        resolve(response);
      } else if (Date.now() - startTime >= timeout) {
        clearInterval(intervalId);
        console.error(`Authorization timed out for ${phoneNumber}`);
        reject(new Error('⏰ *Timed Out* \nAuthorization timed out.'));
      }
    }, 500);
  });
}

// Helper function to send the manage submenu
async function sendManageSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🛠️ Manage Options' },
      body: { text: '*What would you like to manage?* Select an option below:' },
      footer: { text: 'Rental Management App' },
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
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// Helper function to send the tools submenu
async function sendToolsSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🧰 Tools' },
      body: { text: '*Select a tool:*' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'reports', title: '📊 Reports' } },
          { type: 'reply', reply: { id: 'maintenance', title: '🔧 Maintenance' } },
          { type: 'reply', reply: { id: 'info', title: 'ℹ️ Info' } },
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

// Helper function to send the reports submenu
async function sendReportsSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '📊 Reports' },
      body: { text: '*Select a report type:*' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'financial_summary', title: '💵 Financial Summary' } },
          { type: 'reply', reply: { id: 'occupancy_report', title: '🏠 Occupancy Report' } },
          { type: 'reply', reply: { id: 'maintenance_trends', title: '🔧 Maintenance Trends' } },
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

// Helper function to send the info submenu
async function sendInfoSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'ℹ️ Info' },
      body: { text: '*Select what you want info about:*' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'property_info', title: '🏠 Property Info' } },
          { type: 'reply', reply: { id: 'unit_info', title: '🚪 Unit Info' } },
          { type: 'reply', reply: { id: 'tenant_info', title: '👥 Tenant Info' } },
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

// Helper function to prompt property info selection
// promptPropertyInfoSelection
async function promptPropertyInfoSelection(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const properties = await Property.find({ userId: user._id }).populate('images');
  if (!properties.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Properties Found* \nNo properties available to display.');
    return;
  }

  let propertyList = `*🏠 Select a Property for Info* \nReply with the number of the property:\n━━━━━━━━━━━━━━━\n`;
  properties.forEach((property, index) => {
    propertyList += `${index + 1}. *${property.name}* \n   _Address_: ${property.address}\n`;
  });
  propertyList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, propertyList);
  sessions[phoneNumber] = { action: 'select_property_for_info', properties };
}

// Helper function to send property info

async function sendPropertyInfo(phoneNumber, property) {
  console.log(`Sending property info for ${property.name} to ${phoneNumber}`);

  // Fetch the property without populating 'images'
  const propertyDoc = await Property.findById(property._id);
  if (!propertyDoc) {
    console.error(`Property ${property._id} not found`);
    await sendMessage(phoneNumber, '⚠️ *Error* \nProperty not found.');
    return;
  }

  console.log('Property document:', JSON.stringify(propertyDoc, null, 2));

  let images = 'https://via.placeholder.com/150'; // Default fallback
  if (propertyDoc.images && propertyDoc.images.length > 0) {
    const key = propertyDoc.images[0]; // Use the first image
    console.log(`Using key from images[0]: ${key}`);

    const params = {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Expires: 60,
    };

    try {
      images = await s3.getSignedUrlPromise('getObject', params);
      console.log(`Generated signed URL: ${images}`);
    } catch (error) {
      console.error(`Error generating signed URL for key ${key}: ${error.message}`);
    }
  } else {
    console.log(`No images found for property ${property._id}`);
  }

  const caption = `*🏠 Property Details*
━━━━━━━━━━━━━━━
*Name*: ${propertyDoc.name}
*Address*: ${propertyDoc.address}
*Units*: ${propertyDoc.units}
*Total Amount*: $${propertyDoc.totalAmount}
*ID*: ${propertyDoc._id}
*Created At*: ${propertyDoc.createdAt ? new Date(propertyDoc.createdAt).toLocaleDateString() : 'N/A'}
━━━━━━━━━━━━━━━`;

  try {
    await sendImageMessage(phoneNumber, images, caption);
    console.log(`Image message sent to ${phoneNumber} with URL: ${images}`);
  } catch (error) {
    console.error(`Error sending image: ${JSON.stringify(error.response ? error.response.data : error.message)}`);
    await sendMessage(phoneNumber, `⚠️ *Image Error* \nFailed to load image. Here’s the info:\n${caption}`);
  }
}
// Helper function to prompt unit info selection
async function promptUnitInfoSelection(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const units = await Unit.find({ userId: user._id }).populate('images').populate('property');
  if (!units.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Units Found* \nNo units available to display.');
    return;
  }

  let unitList = `*🚪 Select a Unit for Info* \nReply with the number of the unit:\n━━━━━━━━━━━━━━━\n`;
  units.forEach((unit, index) => {
    unitList += `${index + 1}. *${unit.unitNumber}* \n   _Property_: ${unit.property ? unit.property.name : 'N/A'}\n`;
  });
  unitList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, unitList);
  sessions[phoneNumber] = { action: 'select_unit_for_info', units };
}

// Helper function to send unit info
async function sendUnitInfo(phoneNumber, unit) {
  console.log(`Sending unit info for ${unit.unitNumber} to ${phoneNumber}`);

  const unitDoc = await Unit.findById(unit._id).populate('property');
  if (!unitDoc) {
    console.error(`Unit ${unit._id} not found`);
    await sendMessage(phoneNumber, '⚠️ *Error* \nUnit not found.');
    return;
  }

  console.log('Unit document:', JSON.stringify(unitDoc, null, 2));

  let imageUrl = 'https://via.placeholder.com/150';
  if (unitDoc.images && unitDoc.images.length > 0) {
    const key = unitDoc.images[0]; // Use the first image
    console.log(`Using key from images[0]: ${key}`);

    const params = {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Expires: 60,
    };

    try {
      imageUrl = await s3.getSignedUrlPromise('getObject', params);
      console.log(`Generated signed URL: ${imageUrl}`);
    } catch (error) {
      console.error(`Error generating signed URL for key ${key}: ${error.message}`);
    }
  } else {
    console.log(`No images found for unit ${unit._id}`);
  }

  const caption = `*🚪 Unit Details*
━━━━━━━━━━━━━━━
*Unit Number*: ${unitDoc.unitNumber}
*Property*: ${unitDoc.property ? unitDoc.property.name : 'N/A'}
*Rent Amount*: $${unitDoc.rentAmount}
*Floor*: ${unitDoc.floor || 'N/A'}
*Size*: ${unitDoc.size ? unitDoc.size + ' sq ft' : 'N/A'}
*ID*: ${unitDoc._id}
*Created At*: ${unitDoc.createdAt ? new Date(unitDoc.createdAt).toLocaleDateString() : 'N/A'}
━━━━━━━━━━━━━━━`;

  try {
    await sendImageMessage(phoneNumber, imageUrl, caption);
    console.log(`Image message sent to ${phoneNumber} with URL: ${imageUrl}`);
  } catch (error) {
    console.error(`Error sending image: ${JSON.stringify(error.response ? error.response.data : error.message)}`);
    await sendMessage(phoneNumber, `⚠️ *Image Error* \nFailed to load image. Here’s the info:\n${caption}`);
  }
}
// Helper function to prompt tenant info selection
async function promptTenantInfoSelection(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const tenants = await Tenant.find({ userId: user._id }).populate('unitAssigned');
  if (!tenants.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Tenants Found* \nNo tenants available to display.');
    return;
  }

  let tenantList = `*👥 Select a Tenant for Info* \nReply with the number of the tenant:\n━━━━━━━━━━━━━━━\n`;
  tenants.forEach((tenant, index) => {
    tenantList += `${index + 1}. *${tenant.name}* \n   _Unit_: ${tenant.unitAssigned ? tenant.unitAssigned.unitNumber : 'N/A'}\n`;
  });
  tenantList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, tenantList);
  sessions[phoneNumber] = { action: 'select_tenant_for_info', tenants };
}
// Helper function to send tenant info
async function sendTenantInfo(phoneNumber, tenant) {
  console.log(`Sending tenant info for ${tenant.name} to ${phoneNumber}`);

  const tenantDoc = await Tenant.findById(tenant._id).populate('unitAssigned');
  if (!tenantDoc) {
    console.error(`Tenant ${tenant._id} not found`);
    await sendMessage(phoneNumber, '⚠️ *Error* \nTenant not found.');
    return;
  }

  console.log('Tenant document:', JSON.stringify(tenantDoc, null, 2));

  let imageUrl = 'https://via.placeholder.com/150';
  if (tenantDoc.images && tenantDoc.images.length > 0) {
    const key = tenantDoc.images[0]; // Use the first image (photo)
    console.log(`Using key from images[0]: ${key}`);

    const params = {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Expires: 60,
    };

    try {
      imageUrl = await s3.getSignedUrlPromise('getObject', params);
      console.log(`Generated signed URL: ${imageUrl}`);
    } catch (error) {
      console.error(`Error generating signed URL for key ${key}: ${error.message}`);
    }
  } else {
    console.log(`No images found for tenant ${tenant._id}`);
  }

  const caption = `*👥 Tenant Details*
━━━━━━━━━━━━━━━
*Name*: ${tenantDoc.name}
*Phone Number*: ${tenantDoc.phoneNumber}
*Unit*: ${tenantDoc.unitAssigned ? tenantDoc.unitAssigned.unitNumber : 'N/A'}
*Property*: ${tenantDoc.propertyName}
*Lease Start*: ${tenantDoc.lease_start ? new Date(tenantDoc.lease_start).toLocaleDateString() : 'N/A'}
*Deposit*: $${tenantDoc.deposit}
*Rent Amount*: $${tenantDoc.rent_amount}
*Tenant ID*: ${tenantDoc.tenant_id}
*Email*: ${tenantDoc.email || 'N/A'}
*ID Proof*: ${tenantDoc.idProof ? 'Available' : 'N/A'}
*Created At*: ${tenantDoc.createdAt ? new Date(tenantDoc.createdAt).toLocaleDateString() : 'N/A'}
━━━━━━━━━━━━━━━`;

  try {
    await sendImageMessage(phoneNumber, imageUrl, caption);
    console.log(`Image message sent to ${phoneNumber} with URL: ${imageUrl}`);
  } catch (error) {
    console.error(`Error sending image: ${JSON.stringify(error.response ? error.response.data : error.message)}`);
    await sendMessage(phoneNumber, `⚠️ *Image Error* \nFailed to load image. Here’s the info:\n${caption}`);
  }
}
// Helper function for Property Options (Add, Edit, Remove)
async function sendPropertyOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🏠 Property Management' },
      body: { text: '*Manage your properties:* Select an option:' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_property', title: '➕ Add Property' } },
          { type: 'reply', reply: { id: 'edit_property', title: '✏️ Edit Property' } },
          { type: 'reply', reply: { id: 'remove_property', title: '🗑️ Remove Property' } },
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

// Helper function for Unit Options (Add, Edit, Remove)
async function sendUnitOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🚪 Unit Management' },
      body: { text: '*Manage your units:* Select an option:' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_unit', title: '➕ Add Unit' } },
          { type: 'reply', reply: { id: 'edit_unit', title: '✏️ Edit Unit' } },
          { type: 'reply', reply: { id: 'remove_unit', title: '🗑️ Remove Unit' } },
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

// Helper function for Tenant Options (Add, Edit, Remove)
async function sendTenantOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '👥 Tenant Management' },
      body: { text: '*Manage your tenants:* Select an option:' },
      footer: { text: 'Rental Management App' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_tenant', title: '➕ Add Tenant' } },
          { type: 'reply', reply: { id: 'edit_tenant', title: '✏️ Edit Tenant' } },
          { type: 'reply', reply: { id: 'remove_tenant', title: '🗑️ Remove Tenant' } },
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

// Helper function to prompt property selection (for editing)
async function promptPropertySelection(phoneNumber, nextAction) {
  console.log(`Prompting property selection for ${phoneNumber} with nextAction: ${nextAction}`);
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Properties Found* \nAdd a property first to proceed.');
    return;
  }

  let propertyList = `*🏠 Select a Property* \nReply with the number of the property:\n━━━━━━━━━━━━━━━\n`;
  properties.forEach((property, index) => {
    propertyList += `${index + 1}. *${property.name}* \n   _Address_: ${property.address}\n`;
  });
  propertyList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, propertyList);
  console.log(`Property list sent to ${phoneNumber}: ${propertyList}`);

  sessions[phoneNumber] = { action: 'select_property', properties, nextAction };
}

// Helper function to prompt tenant selection (for editing)
async function promptTenantSelection(phoneNumber, action, propertyId) {
  console.log(`Prompting tenant selection for property ${propertyId} for ${phoneNumber}`);
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const tenants = await Tenant.find({ userId: user._id })
    .populate('unitAssigned')
    .then(tenants => tenants.filter(tenant => tenant.unitAssigned && tenant.unitAssigned.property.toString() === propertyId.toString()));

  if (!tenants.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Tenants Found* \nNo tenants are assigned to this property.');
    return;
  }

  let tenantList = `*👥 Select a Tenant to Edit* \nReply with the number of the tenant:\n━━━━━━━━━━━━━━━\n`;
  tenants.forEach((tenant, index) => {
    tenantList += `${index + 1}. *${tenant.name}* \n   _ID_: ${tenant.tenant_id || tenant._id}\n`;
  });
  tenantList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, tenantList);
  console.log(`Tenant list sent to ${phoneNumber}: ${tenantList}`);

  sessions[phoneNumber].tenants = tenants;
}

// Helper function to send property link (for add/edit actions)
async function sendPropertyLink(phoneNumber, action, tenantId = null) {
  console.log(`sendPropertyLink called for phoneNumber: ${phoneNumber}, action: ${action}, tenantId: ${tenantId}`);
  try {
    let authorizeRecord = await Authorize.findOne({ phoneNumber: `+${phoneNumber}` });
    if (!authorizeRecord) {
      authorizeRecord = new Authorize({
        phoneNumber: `+${phoneNumber}`,
        used: false,
        action: action,
        createdAt: new Date(),
      });
      await authorizeRecord.save();
      console.log(`New authorization record created with ID: ${authorizeRecord._id}, action: ${action}`);
    } else {
      authorizeRecord.action = action;
      authorizeRecord.used = false;
      await authorizeRecord.save();
      console.log(`Updated authorization record with ID: ${authorizeRecord._id}, action: ${action}`);
    }

    const baseUrl = `${GLITCH_HOST}/authorize/${authorizeRecord._id}`;
    const longUrl = tenantId ? `${baseUrl}?tenantId=${tenantId}` : baseUrl;
    console.log(`Long URL generated: ${longUrl}`);

    const shortUrl = await shortenUrl(longUrl);
    console.log(`Short URL generated: ${shortUrl}`);

    await sendMessage(phoneNumber, `🔗 *Action Link* \nPlease proceed using this link to ${action === 'addproperty' ? 'add a property' : 'edit'}: *${shortUrl}*`);
    console.log(`Link sent to ${phoneNumber} for action: ${action}`);
  } catch (error) {
    console.error('Error in sendPropertyLink:', error);
    await sendMessage(phoneNumber, '❌ *Error* \nFailed to generate the action link. Please try again.');
  }
}

// Helper function to prompt property removal
async function promptPropertyRemoval(phoneNumber) {
  console.log(`Prompting property removal selection for ${phoneNumber}`);
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Properties Found* \nNo properties available to remove.');
    return;
  }

  let propertyList = `*🏠 Select a Property to Remove* \nReply with the number of the property:\n━━━━━━━━━━━━━━━\n`;
  properties.forEach((property, index) => {
    propertyList += `${index + 1}. *${property.name}* \n   _Address_: ${property.address}\n`;
  });
  propertyList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, propertyList);
  console.log(`Property removal list sent to ${phoneNumber}: ${propertyList}`);

  sessions[phoneNumber] = { action: 'select_property_to_remove', properties };
}

// Helper function to confirm property removal
async function confirmPropertyRemoval(phoneNumber, property) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const units = await Unit.find({ property: property._id });
  if (units.length > 0) {
    await sendMessage(phoneNumber, `⚠️ *Cannot Remove Property* \nProperty *${property.name}* has ${units.length} unit(s) assigned. Please remove the units first.`);
    sessions[phoneNumber].action = null;
    return;
  }

  const confirmationMessage = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `🗑️ *Confirm Property Removal*\nAre you sure you want to remove *${property.name}*?\n*WARNING*: This action is permanent and cannot be undone.` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_remove_property', title: '✅ Yes' } },
          { type: 'reply', reply: { id: 'no_remove_property', title: '❌ No' } },
        ],
      },
    },
  };

  await axios.post(WHATSAPP_API_URL, confirmationMessage, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  console.log(`Property removal confirmation sent to ${phoneNumber} for property: ${property.name}`);
}

// Helper function to prompt unit removal
async function promptUnitRemoval(phoneNumber) {
  console.log(`Prompting unit removal selection for ${phoneNumber}`);
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const units = await Unit.find({ userId: user._id });
  if (!units.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Units Found* \nNo units available to remove.');
    return;
  }

  let unitList = `*🚪 Select a Unit to Remove* \nReply with the number of the unit:\n━━━━━━━━━━━━━━━\n`;
  units.forEach((unit, index) => {
    unitList += `${index + 1}. *${unit.unitNumber}* \n   _ID_: ${unit._id}\n`;
  });
  unitList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, unitList);
  console.log(`Unit removal list sent to ${phoneNumber}: ${unitList}`);

  sessions[phoneNumber] = { action: 'select_unit_to_remove', units };
}

// Helper function to confirm unit removal
async function confirmUnitRemoval(phoneNumber, unit) {
  const tenants = await Tenant.find({ unitAssigned: unit._id });
  
  if (tenants.length > 0) {
    const tenantList = tenants.map(t => `- ${t.name}`).join('\n');
    await sendMessage(phoneNumber,
      `⚠️ *Cannot Remove Unit*\nUnit ${unit.unitNumber} has tenants:\n${tenantList}\nRemove tenants first.`
    );
    return;
  }
  

  const confirmationMessage = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `🗑️ *Confirm Unit Removal*\nAre you sure you want to remove *${unit.unitNumber}*?\n*WARNING*: This action is permanent and cannot be undone.` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_remove_unit', title: '✅ Yes' } },
          { type: 'reply', reply: { id: 'no_remove_unit', title: '❌ No' } },
        ],
      },
    },
  };

  await axios.post(WHATSAPP_API_URL, confirmationMessage, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  console.log(`Unit removal confirmation sent to ${phoneNumber} for unit: ${unit.unitNumber}`);
}

// Helper function to prompt tenant removal
async function promptTenantRemoval(phoneNumber) {
  console.log(`Prompting tenant removal selection for ${phoneNumber}`);
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const tenants = await Tenant.find({ userId: user._id });
  if (!tenants.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Tenants Found* \nNo tenants available to remove.');
    return;
  }

  let tenantList = `*👥 Select a Tenant to Remove* \nReply with the number of the tenant:\n━━━━━━━━━━━━━━━\n`;
  tenants.forEach((tenant, index) => {
    tenantList += `${index + 1}. *${tenant.name}* \n   _ID_: ${tenant.tenant_id || tenant._id}\n`;
  });
  tenantList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, tenantList);
  console.log(`Tenant removal list sent to ${phoneNumber}: ${tenantList}`);

  sessions[phoneNumber] = { action: 'select_tenant_to_remove', tenants };
}

// Helper function to confirm tenant removal
async function confirmTenantRemoval(phoneNumber, tenant) {
  const confirmationMessage = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `🗑️ *Confirm Tenant Removal*\nAre you sure you want to remove *${tenant.name}*?\n*WARNING*: This action is permanent and cannot be undone.` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_remove_tenant', title: '✅ Yes' } },
          { type: 'reply', reply: { id: 'no_remove_tenant', title: '❌ No' } },
        ],
      },
    },
  };

  await axios.post(WHATSAPP_API_URL, confirmationMessage, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  console.log(`Tenant removal confirmation sent to ${phoneNumber} for tenant: ${tenant.name}`);
}

// Export the module
module.exports = {
  router,
  waitForUserResponse,
  userResponses,
  sessions,
  sendMessage,
};