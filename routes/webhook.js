const express = require('express');
const axios = require('axios');
const dialogflow = require('dialogflow');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Authorize = require('../models/Authorize');

const router = express.Router();

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;

// Dialogflow credentials
const DIALOGFLOW_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID;
const sessionClient = new dialogflow.SessionsClient({
  projectId: DIALOGFLOW_PROJECT_ID,
  credentials: {
    client_email: process.env.DIALOGFLOW_CLIENT_EMAIL,
    private_key: process.env.DIALOGFLOW_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
});

// Session management
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

// Helper function to send WhatsApp message
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

// Helper function to query Dialogflow
async function getDialogflowResponse(phoneNumber, message) {
  const sessionPath = sessionClient.sessionPath(DIALOGFLOW_PROJECT_ID, phoneNumber);
  const request = {
    session: sessionPath,
    queryInput: {
      text: {
        text: message,
        languageCode: 'en',
      },
    },
  };

  try {
    const responses = await sessionClient.detectIntent(request);
    const result = responses[0].queryResult;
    return {
      fulfillmentText: result.fulfillmentText,
      intent: result.intent.displayName,
      action: result.action,
      parameters: result.parameters.fields,
    };
  } catch (error) {
    console.error('Error with Dialogflow:', error);
    return { fulfillmentText: '⚠️ Sorry, something went wrong. Try again or type "Help".' };
  }
}

// Webhook verification
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

// Main WhatsApp webhook
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
      const user = await User.findOne({ phoneNumber: contactPhoneNumber });
      if (user && profileName) {
        user.profileName = profileName;
        await user.save();
      }
    }

    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;
      const phoneNumber = `+${fromNumber}`;
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      if (interactive && interactive.type === 'button_reply') {
        userResponses[fromNumber] = interactive.button_reply.id;
      }

      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      if (text) {
        if (sessions[fromNumber].action === 'select_property') {
          const propertyIndex = parseInt(text) - 1;
          const properties = sessions[fromNumber].properties;
          if (propertyIndex >= 0 && propertyIndex < properties.length) {
            const selectedProperty = properties[propertyIndex];
            await promptTenantSelection(fromNumber, 'edittenant', selectedProperty._id);
            sessions[fromNumber].action = 'select_tenant_to_edit';
            sessions[fromNumber].propertyId = selectedProperty._id;
          } else {
            await sendMessage(fromNumber, '❌ Invalid property selection.');
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
            await sendMessage(fromNumber, '❌ Invalid tenant selection.');
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
            await sendMessage(fromNumber, '❌ Invalid property selection.');
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
            await sendMessage(fromNumber, '❌ Invalid unit selection.');
          }
        } else if (sessions[fromNumber].action === 'select_property_to_remove_tenant') {
          const propertyIndex = parseInt(text) - 1;
          const properties = sessions[fromNumber].properties;
          if (propertyIndex >= 0 && propertyIndex < properties.length) {
            const selectedProperty = properties[propertyIndex];
            await promptTenantRemoval(fromNumber, selectedProperty._id);
            sessions[fromNumber].action = 'select_tenant_to_remove';
            sessions[fromNumber].propertyId = selectedProperty._id;
          } else {
            await sendMessage(fromNumber, '❌ Invalid property selection.');
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
            await sendMessage(fromNumber, '❌ Invalid tenant selection.');
          }
        } else if (sessions[fromNumber].action === 'rent_paid') {
          const tenantId = text.trim();
          const tenant = await Tenant.findOne({ tenant_id: tenantId });
          if (tenant) {
            tenant.status = 'paid';
            await tenant.save();
            await sendMessage(fromNumber, `✅ Rent payment confirmed for Tenant ID: ${tenantId}.`);
            sessions[fromNumber].action = null;
          } else {
            await sendMessage(fromNumber, `⚠️ Tenant with ID "${tenantId}" not found.`);
          }
        } else {
          const dialogflowResponse = await getDialogflowResponse(fromNumber, text);
          if (dialogflowResponse.action === 'trigger_help') {
            await sendHelpMenu(fromNumber);
          } else if (dialogflowResponse.action === 'manage_properties') {
            await sendPropertyOptions(fromNumber);
          } else if (dialogflowResponse.action === 'manage_units') {
            await sendUnitOptions(fromNumber);
          } else if (dialogflowResponse.action === 'manage_tenants') {
            await sendTenantOptions(fromNumber);
          } else if (dialogflowResponse.action === 'add_tenant') {
            await sendPropertyLink(fromNumber, 'addtenant');
          } else if (dialogflowResponse.action === 'remove_tenant') {
            await promptPropertySelectionForTenantRemoval(fromNumber);
          } else if (dialogflowResponse.action === 'rent_paid' && dialogflowResponse.parameters.tenantId) {
            const tenantId = dialogflowResponse.parameters.tenantId.stringValue;
            const tenant = await Tenant.findOne({ tenant_id: tenantId });
            if (tenant) {
              tenant.status = 'paid';
              await tenant.save();
              await sendMessage(fromNumber, `✅ Rent payment confirmed for Tenant ID: ${tenantId}.`);
            } else {
              await sendMessage(fromNumber, `⚠️ Tenant with ID "${tenantId}" not found.`);
            }
          } else {
            await sendMessage(fromNumber, dialogflowResponse.fulfillmentText);
          }
        }
      }

      if (interactive) {
        const selectedOption = interactive.button_reply.id;
        if (sessions[fromNumber].action === 'confirm_property_removal') {
          if (selectedOption === 'yes_remove_property') {
            const property = sessions[fromNumber].propertyToRemove;
            await Property.findByIdAndDelete(property._id);
            await sendMessage(fromNumber, `✅ Property "${property.name}" deleted successfully!`);
          } else if (selectedOption === 'no_remove_property') {
            await sendMessage(fromNumber, `ℹ️ Property "${sessions[fromNumber].propertyToRemove.name}" removal canceled.`);
          }
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].propertyToRemove;
          delete sessions[fromNumber].properties;
        } else if (sessions[fromNumber].action === 'confirm_unit_removal') {
          if (selectedOption === 'yes_remove_unit') {
            const unit = sessions[fromNumber].unitToRemove;
            await Unit.findByIdAndDelete(unit._id);
            await sendMessage(fromNumber, `✅ Unit "${unit.unitNumber}" deleted successfully!`);
          } else if (selectedOption === 'no_remove_unit') {
            await sendMessage(fromNumber, `ℹ️ Unit "${sessions[fromNumber].unitToRemove.unitNumber}" removal canceled.`);
          }
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].unitToRemove;
          delete sessions[fromNumber].units;
        } else if (sessions[fromNumber].action === 'confirm_tenant_removal') {
          if (selectedOption === 'yes_remove_tenant') {
            const tenant = sessions[fromNumber].tenantToRemove;
            await Tenant.findByIdAndDelete(tenant._id);
            await sendMessage(fromNumber, `✅ Tenant "${tenant.name}" deleted successfully!`);
          } else if (selectedOption === 'no_remove_tenant') {
            await sendMessage(fromNumber, `ℹ️ Tenant "${sessions[fromNumber].tenantToRemove.name}" removal canceled.`);
          }
          sessions[fromNumber].action = null;
          delete sessions[fromNumber].tenantToRemove;
          delete sessions[fromNumber].tenants;
          delete sessions[fromNumber].propertyId;
        } else if (selectedOption === 'manage_properties') {
          await sendPropertyOptions(fromNumber);
        } else if (selectedOption === 'manage_units') {
          await sendUnitOptions(fromNumber);
        } else if (selectedOption === 'manage_tenants') {
          await sendTenantOptions(fromNumber);
        } else if (selectedOption === 'add_property') {
          await sendPropertyLink(fromNumber, 'addproperty');
        } else if (selectedOption === 'edit_property') {
          const user = await User.findOne({ phoneNumber: `+${fromNumber}` });
          const properties = await Property.find({ userId: user._id });
          if (!properties.length) {
            await sendMessage(fromNumber, '🏠 No properties to edit.');
          } else {
            await sendPropertyLink(fromNumber, 'editproperty');
          }
        } else if (selectedOption === 'remove_property') {
          await promptPropertyRemoval(fromNumber);
        } else if (selectedOption === 'add_unit') {
          await sendPropertyLink(fromNumber, 'addunit');
        } else if (selectedOption === 'edit_unit') {
          const user = await User.findOne({ phoneNumber: `+${fromNumber}` });
          const units = await Unit.find({ userId: user._id });
          if (!units.length) {
            await sendMessage(fromNumber, '🏡 No units to edit.');
          } else {
            await sendPropertyLink(fromNumber, 'editunit');
          }
        } else if (selectedOption === 'remove_unit') {
          await promptUnitRemoval(fromNumber);
        } else if (selectedOption === 'add_tenant') {
          await sendPropertyLink(fromNumber, 'addtenant');
        } else if (selectedOption === 'edit_tenant') {
          await promptPropertySelection(fromNumber, 'edittenant');
        } else if (selectedOption === 'remove_tenant') {
          await promptPropertySelectionForTenantRemoval(fromNumber);
        }
      }
    }
  }
  res.sendStatus(200);
});

// Dialogflow fulfillment webhook
router.post('/dialogflow-webhook', async (req, res) => {
  const intent = req.body.queryResult.intent.displayName;
  const parameters = req.body.queryResult.parameters;
  const phoneNumber = req.body.session.split('/').pop();

  let responseText = '';

  switch (intent) {
    case 'Help':
      responseText = '🏠 Type "Manage Properties", "Manage Units", or "Manage Tenants" to get started!';
      break;
    case 'RentPaid':
      if (parameters.tenantId) {
        const tenantId = parameters.tenantId;
        const tenant = await Tenant.findOne({ tenant_id: tenantId });
        if (tenant) {
          tenant.status = 'paid';
          await tenant.save();
          responseText = `✅ Rent payment confirmed for Tenant ID: ${tenantId}.`;
        } else {
          responseText = `⚠️ Tenant with ID "${tenantId}" not found.`;
        }
      }
      break;
    default:
      responseText = '🤔 I’m not sure how to help with that. Try "Help" for options.';
  }

  res.json({ fulfillmentText: responseText });
});

// Helper functions
async function sendHelpMenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🏠 Choose an Option' },
      body: { text: 'Please select an option below:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'manage_properties', title: '🏠 Manage Properties' } },
          { type: 'reply', reply: { id: 'manage_units', title: '🏡 Manage Units' } },
          { type: 'reply', reply: { id: 'manage_tenants', title: '👥 Manage Tenants' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  });
}

async function sendPropertyOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🏠 Property Options' },
      body: { text: 'Please select an option:' },
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
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  });
}

async function sendUnitOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🏡 Unit Options' },
      body: { text: 'Please select an option:' },
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
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  });
}

async function sendTenantOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '👥 Tenant Options' },
      body: { text: 'Please select an option:' },
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
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  });
}

async function promptPropertySelection(phoneNumber, action) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, '🏠 No properties to edit.');
    sessions[phoneNumber].action = null;
    return;
  }
  let propertyList = '🏠 Select a property by replying with its number:\n';
  properties.forEach((p, i) => propertyList += `${i + 1}. ${p.name} (📍 ${p.address})\n`);
  await sendMessage(phoneNumber, propertyList);
  sessions[phoneNumber] = { action: 'select_property', properties };
}

async function promptTenantSelection(phoneNumber, action, propertyId) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  const tenants = await Tenant.find({ userId: user._id })
    .populate('unitAssigned')
    .then(t => t.filter(tenant => tenant.unitAssigned && tenant.unitAssigned.property.toString() === propertyId.toString()));
  if (!tenants.length) {
    await sendMessage(phoneNumber, '👥 No tenants to edit for this property.');
    sessions[phoneNumber].action = null;
    delete sessions[phoneNumber].propertyId;
    return;
  }
  let tenantList = '👥 Select a tenant to edit by replying with their number:\n';
  tenants.forEach((t, i) => tenantList += `${i + 1}. ${t.name} (🆔 ${t.tenant_id || t._id})\n`);
  await sendMessage(phoneNumber, tenantList);
  sessions[phoneNumber].tenants = tenants;
}

async function promptPropertySelectionForTenantRemoval(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, '🏠 No properties to delete tenants from.');
    sessions[phoneNumber].action = null;
    return;
  }
  let propertyList = '🏠 Select a property to remove a tenant from:\n';
  properties.forEach((p, i) => propertyList += `${i + 1}. ${p.name} (📍 ${p.address})\n`);
  await sendMessage(phoneNumber, propertyList);
  sessions[phoneNumber] = { action: 'select_property_to_remove_tenant', properties };
}

async function promptTenantRemoval(phoneNumber, propertyId) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  const tenants = await Tenant.find({ userId: user._id })
    .populate('unitAssigned')
    .then(t => t.filter(tenant => tenant.unitAssigned && tenant.unitAssigned.property.toString() === propertyId.toString()));
  if (!tenants.length) {
    await sendMessage(phoneNumber, '👥 No tenants to delete for this property.');
    sessions[phoneNumber].action = null;
    delete sessions[phoneNumber].propertyId;
    return;
  }
  let tenantList = '👥 Select a tenant to remove:\n';
  tenants.forEach((t, i) => tenantList += `${i + 1}. ${t.name} (🆔 ${t.tenant_id || t._id})\n`);
  await sendMessage(phoneNumber, tenantList);
  sessions[phoneNumber].tenants = tenants;
}

async function promptPropertyRemoval(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, '🏠 No properties to delete.');
    sessions[phoneNumber].action = null;
    return;
  }
  let propertyList = '🏠 Select a property to remove by replying with its number:\n';
  properties.forEach((p, i) => propertyList += `${i + 1}. ${p.name} (📍 ${p.address})\n`);
  await sendMessage(phoneNumber, propertyList);
  sessions[phoneNumber] = { action: 'select_property_to_remove', properties };
}

async function promptUnitRemoval(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  const units = await Unit.find({ userId: user._id });
  if (!units.length) {
    await sendMessage(phoneNumber, '🏡 No units to delete.');
    sessions[phoneNumber].action = null;
    return;
  }
  let unitList = '🏡 Select a unit to remove by replying with its number:\n';
  units.forEach((u, i) => unitList += `${i + 1}. ${u.unitNumber} (🆔 ${u.unit_id || u._id})\n`);
  await sendMessage(phoneNumber, unitList);
  sessions[phoneNumber] = { action: 'select_unit_to_remove', units };
}

async function confirmPropertyRemoval(phoneNumber, property) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  const units = await Unit.find({ property: property._id });
  if (units.length > 0) {
    await sendMessage(phoneNumber, `🏡 Units defined under "${property.name}". Remove them first.`);
    sessions[phoneNumber].action = null;
    return;
  }
  const confirmationMessage = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `🗑️ Are you sure you want to remove "${property.name}"?` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_remove_property', title: 'Yes' } },
          { type: 'reply', reply: { id: 'no_remove_property', title: 'No' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, confirmationMessage, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  });
}

async function confirmUnitRemoval(phoneNumber, unit) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  const tenants = await Tenant.find({ unitAssigned: unit._id });
  if (tenants.length > 0) {
    await sendMessage(phoneNumber, `👥 Tenants assigned to "${unit.unitNumber}". Remove them first.`);
    sessions[phoneNumber].action = null;
    return;
  }
  const confirmationMessage = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `🗑️ Are you sure you want to remove "${unit.unitNumber}"?` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_remove_unit', title: 'Yes' } },
          { type: 'reply', reply: { id: 'no_remove_unit', title: 'No' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, confirmationMessage, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  });
}

async function confirmTenantRemoval(phoneNumber, tenant) {
  const confirmationMessage = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `🗑️ Are you sure you want to remove "${tenant.name}"?` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_remove_tenant', title: 'Yes' } },
          { type: 'reply', reply: { id: 'no_remove_tenant', title: 'No' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, confirmationMessage, {
    headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  });
}

async function sendPropertyLink(phoneNumber, action, tenantId = null) {
  let authorizeRecord = await Authorize.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!authorizeRecord) {
    authorizeRecord = new Authorize({ phoneNumber: `+${phoneNumber}`, used: false, action });
  } else {
    authorizeRecord.action = action;
    authorizeRecord.used = false;
  }
  await authorizeRecord.save();
  const baseUrl = `${GLITCH_HOST}/authorize/${authorizeRecord._id}`;
  const longUrl = tenantId ? `${baseUrl}?tenantId=${tenantId}` : baseUrl;
  const shortUrl = await shortenUrl(longUrl);
  await sendMessage(phoneNumber, `🔗 Proceed: ${shortUrl}`);
}

module.exports = { router, sendMessage, sessions, userResponses };