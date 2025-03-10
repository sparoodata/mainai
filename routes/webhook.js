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
const AWS = require('aws-sdk');

const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4',
});

const sessions = {};
let userResponses = {};

async function shortenUrl(longUrl) {
  try {
    const response = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl));
    return response.data;
  } catch (error) {
    console.error('Error shortening URL:', error.response ? error.response.data : error);
    return longUrl;
  }
}

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
          const propertyIndex = parseInt(text) - 1;
          const properties = sessions[fromNumber].properties;

          if (propertyIndex >= 0 && propertyIndex < properties.length) {
            const selectedProperty = properties[propertyIndex];
            await promptTenantSelection(fromNumber, 'edittenant', selectedProperty._id);
            sessions[fromNumber].action = 'select_tenant_to_edit';
            sessions[fromNumber].propertyId = selectedProperty._id;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid property number.');
          }
        } else if (sessions[fromNumber].action === 'select_tenant_to_edit') {
          const tenantIndex = parseInt(text) - 1;
          const tenants = sessions[fromNumber].tenants;

          if (tenantIndex >= 0 && tenantIndex < tenants.length) {
            const selectedTenant = tenants[tenantIndex];
            await sendPropertyLink(fromNumber, 'edittenant', selectedTenant._id);
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].propertyId;
            delete sessions[fromNumber].tenants;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid tenant number.');
          }
        } else if (sessions[fromNumber].action === 'select_property_to_remove') {
          const propertyIndex = parseInt(text) - 1;
          const properties = sessions[fromNumber].properties;

          if (propertyIndex >= 0 && propertyIndex < properties.length) {
            const selectedProperty = properties[propertyIndex];
            await confirmPropertyRemoval(fromNumber, selectedProperty);
            sessions[fromNumber].action = 'confirm_property_removal';
            sessions[fromNumber].propertyToRemove = selectedProperty;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid property number.');
          }
        } else if (sessions[fromNumber].action === 'select_unit_to_remove') {
          const unitIndex = parseInt(text) - 1;
          const units = sessions[fromNumber].units;

          if (unitIndex >= 0 && unitIndex < units.length) {
            const selectedUnit = units[unitIndex];
            await confirmUnitRemoval(fromNumber, selectedUnit);
            sessions[fromNumber].action = 'confirm_unit_removal';
            sessions[fromNumber].unitToRemove = selectedUnit;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid unit number.');
          }
        } else if (sessions[fromNumber].action === 'select_tenant_to_remove') {
          const tenantIndex = parseInt(text) - 1;
          const tenants = sessions[fromNumber].tenants;

          if (tenantIndex >= 0 && tenantIndex < tenants.length) {
            const selectedTenant = tenants[tenantIndex];
            await confirmTenantRemoval(fromNumber, selectedTenant);
            sessions[fromNumber].action = 'confirm_tenant_removal';
            sessions[fromNumber].tenantToRemove = selectedTenant;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid tenant number.');
          }
        } else if (sessions[fromNumber].action === 'select_property_for_info') {
          const propertyIndex = parseInt(text) - 1;
          const properties = sessions[fromNumber].properties;

          if (propertyIndex >= 0 && propertyIndex < properties.length) {
            const selectedProperty = properties[propertyIndex];
            await sendPropertyInfo(fromNumber, selectedProperty);
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].properties;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid property number.');
          }
        } else if (sessions[fromNumber].action === 'select_tenant_for_info') {
          const tenantIndex = parseInt(text) - 1;
          const tenants = sessions[fromNumber].tenants;

          if (tenantIndex >= 0 && tenantIndex < tenants.length) {
            const selectedTenant = tenants[tenantIndex];
            await sendTenantInfo(fromNumber, selectedTenant);
            sessions[fromNumber].action = null;
            delete sessions[fromNumber].tenants;
          } else {
            await sendMessage(fromNumber, '⚠️ *Invalid Selection* \nPlease reply with a valid tenant number.');
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
                  { type: 'reply', reply: { id: 'manage', title: '🛠️ Manage' } },
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
        } else if (text.startsWith('\\')) {
          const query = text.substring(1).trim();
          const aiResponse = await getGroqAIResponse(query, phoneNumber, true);
          await sendMessage(fromNumber, aiResponse);
        } else if (!sessions[fromNumber].action) {
          const aiResponse = await getGroqAIResponse(text, phoneNumber, false);
          await sendMessage(fromNumber, aiResponse);
        }
      }

      if (interactive) {
        const selectedOption = interactive.button_reply.id;

        if (sessions[fromNumber].action === 'confirm_property_removal' && selectedOption === 'yes_remove_property') {
          const property = sessions[fromNumber].propertyToRemove;
          try {
            await Property.findByIdAndDelete(property._id);
            await sendMessage(fromNumber, `✅ *Success* \nProperty *${property.name}* has been deleted successfully!`);
          } catch (error) {
            console.error(`Error deleting property ${property._id}:`, error);
            await sendMessage(fromNumber, `❌ *Error* \nFailed to delete property *${property.name}*. Please try again.`);
          }
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].propertyToRemove;
        } else if (sessions[fromNumber].action === 'confirm_property_removal' && selectedOption === 'no_remove_property') {
          await sendMessage(fromNumber, `ℹ️ *Canceled* \nRemoval of property *${sessions[fromNumber].propertyToRemove.name}* has been canceled.`);
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].propertyToRemove;
        } else if (sessions[fromNumber].action === 'confirm_unit_removal' && selectedOption === 'yes_remove_unit') {
          const unit = sessions[fromNumber].unitToRemove;
          try {
            await Unit.findByIdAndDelete(unit._id);
            await sendMessage(fromNumber, `✅ *Success* \nUnit *${unit.unitNumber}* has been deleted successfully!`);
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
        } else if (sessions[fromNumber].action === 'confirm_tenant_removal' && selectedOption === 'yes_remove_tenant') {
          const tenant = sessions[fromNumber].tenantToRemove;
          try {
            await Tenant.findByIdAndDelete(tenant._id);
            await sendMessage(fromNumber, `✅ *Success* \nTenant *${tenant.name}* has been deleted successfully!`);
          } catch (error) {
            console.error(`Error deleting tenant ${tenant._id}:`, error);
            await sendMessage(fromNumber, `❌ *Error* \nFailed to delete tenant *${tenant.name}*. Please try again.`);
          }
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].tenantToRemove;
        } else if (sessions[fromNumber].action === 'confirm_tenant_removal' && selectedOption === 'no_remove_tenant') {
          await sendMessage(fromNumber, `ℹ️ *Canceled* \nRemoval of tenant *${sessions[fromNumber].tenantToRemove.name}* has been canceled.`);
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].tenantToRemove;
        } else if (selectedOption === 'manage') {
          await sendManageSubmenu(fromNumber);
        } else if (selectedOption === 'info') {
          await sendInfoSubmenu(fromNumber);
        } else if (selectedOption === 'property_info') {
          await promptPropertyInfoSelection(fromNumber);
        } else if (selectedOption === 'tenant_info') {
          await promptTenantInfoSelection(fromNumber);
        } else if (selectedOption === 'unit_info') {
          await sendMessage(fromNumber, '🚪 *Unit Info* \nThis feature is coming soon!');
        } else if (selectedOption === 'manage_properties') {
          await sendPropertyOptions(fromNumber);
        } else if (selectedOption === 'manage_units') {
          await sendUnitOptions(fromNumber);
        } else if (selectedOption === 'manage_tenants') {
          await sendTenantOptions(fromNumber);
        } else if (selectedOption === 'add_property') {
          await sendPropertyLink(fromNumber, 'addproperty');
        } else if (selectedOption === 'edit_property') {
          await sendPropertyLink(fromNumber, 'editproperty');
        } else if (selectedOption === 'remove_property') {
          await promptPropertyRemoval(fromNumber);
        } else if (selectedOption === 'remove_unit') {
          await promptUnitRemoval(fromNumber);
        } else if (selectedOption === 'add_tenant') {
          await sendPropertyLink(fromNumber, 'addtenant');
        } else if (selectedOption === 'edit_tenant') {
          await promptPropertySelection(fromNumber, 'edittenant');
        } else if (selectedOption === 'remove_tenant') {
          await promptTenantRemoval(fromNumber);
        } else {
          await sendMessage(fromNumber, '🔜 *Coming Soon* \nThis feature is under development!');
        }
      }
    }
  } else {
    return res.sendStatus(404);
  }

  res.sendStatus(200);
});

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

async function promptPropertyInfoSelection(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
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

async function sendPropertyInfo(phoneNumber, property) {
  const propertyDoc = await Property.findById(property._id);
  if (!propertyDoc) {
    await sendMessage(phoneNumber, '⚠️ *Error* \nProperty not found.');
    return;
  }

  let images = 'https://via.placeholder.com/150';
  if (propertyDoc.images && propertyDoc.images.length > 0) {
    const key = propertyDoc.images[0];
    const params = {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Expires: 60,
    };
    try {
      images = await s3.getSignedUrlPromise('getObject', params);
    } catch (error) {
      console.error(`Error generating signed URL: ${error.message}`);
    }
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

  await sendImageMessage(phoneNumber, images, caption);
}

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

async function sendTenantInfo(phoneNumber, tenant) {
  const tenantDoc = await Tenant.findById(tenant._id).populate('unitAssigned');
  if (!tenantDoc) {
    await sendMessage(phoneNumber, '⚠️ *Error* \nTenant not found.');
    return;
  }

  let imageUrl = 'https://via.placeholder.com/150';
  if (tenantDoc.images && tenantDoc.images.length > 0) {
    const key = tenantDoc.images[0];
    const params = {
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Expires: 60,
    };
    try {
      imageUrl = await s3.getSignedUrlPromise('getObject', params);
    } catch (error) {
      console.error(`Error generating signed URL: ${error.message}`);
    }
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

  await sendImageMessage(phoneNumber, imageUrl, caption);
}

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

async function promptPropertySelection(phoneNumber, action) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '⚠️ *User Not Found* \nNo account associated with this number.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, 'ℹ️ *No Properties Found* \nAdd a property first to manage tenants.');
    return;
  }

  let propertyList = `*🏠 Select a Property* \nReply with the number of the property:\n━━━━━━━━━━━━━━━\n`;
  properties.forEach((property, index) => {
    propertyList += `${index + 1}. *${property.name}* \n   _Address_: ${property.address}\n`;
  });
  propertyList += `━━━━━━━━━━━━━━━`;
  await sendMessage(phoneNumber, propertyList);
  sessions[phoneNumber] = { action: 'select_property', properties };
}

async function promptTenantSelection(phoneNumber, action, propertyId) {
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
  sessions[phoneNumber].tenants = tenants;
}

async function sendPropertyLink(phoneNumber, action, tenantId = null) {
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
    } else {
      authorizeRecord.action = action;
      authorizeRecord.used = false;
      await authorizeRecord.save();
    }

    const baseUrl = `${GLITCH_HOST}/authorize/${authorizeRecord._id}`;
    const longUrl = tenantId ? `${baseUrl}?tenantId=${tenantId}` : baseUrl;
    const shortUrl = await shortenUrl(longUrl);

    await sendMessage(phoneNumber, `🔗 *Action Link* \nPlease proceed using this link to ${action === 'addproperty' ? 'add a property' : 'edit'}: *${shortUrl}*`);
  } catch (error) {
    console.error('Error in sendPropertyLink:', error);
    await sendMessage(phoneNumber, '❌ *Error* \nFailed to generate the action link. Please try again.');
  }
}

async function promptPropertyRemoval(phoneNumber) {
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
  sessions[phoneNumber] = { action: 'select_property_to_remove', properties };
}

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
}

async function promptUnitRemoval(phoneNumber) {
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
  sessions[phoneNumber] = { action: 'select_unit_to_remove', units };
}

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
}

async function promptTenantRemoval(phoneNumber) {
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
  sessions[phoneNumber] = { action: 'select_tenant_to_remove', tenants };
}

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
}

module.exports = {
  router,
  waitForUserResponse: async (phoneNumber, timeout = 30000) => {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const intervalId = setInterval(() => {
        if (userResponses[phoneNumber]) {
          const response = userResponses[phoneNumber];
          clearInterval(intervalId);
          delete userResponses[phoneNumber];
          resolve(response);
        } else if (Date.now() - startTime >= timeout) {
          clearInterval(intervalId);
          reject(new Error('⏰ *Timed Out* \nAuthorization timed out.'));
        }
      }, 500);
    });
  },
  userResponses,
  sessions,
  sendMessage,
};