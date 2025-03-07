const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Authorize = require('../models/Authorize');
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const { body, validationResult } = require('express-validator');

const router = express.Router();

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST;

const sessions = {};
let userResponses = {};

async function shortenUrl(longUrl) {
  try {
    const response = await axios.post(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`);
    return response.data;
  } catch (error) {
    console.error('Error shortening URL:', error);
    return longUrl;
  }
}

async function getGroqAIResponse(message, phoneNumber, isAssistanceMode) {
  const systemPrompt = isAssistanceMode
    ? "You are an AI assistant for a rental management app. Suggest 'Help' for the menu or assist with the query."
    : "You are an AI agent for a rental management app. Suggest 'Help' for the menu if needed, otherwise respond naturally.";

  try {
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
    return '*Error*\nSorry, I encountered an issue. Please try again or type "Help" for assistance.';
  }
}

async function sendMessage(phoneNumber, message) {
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
}

router.get('/', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post('/', [
  body('entry[0].changes[0].value.messages[0].text.body').optional().trim().escape(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

  const entry = body.entry[0];
  const changes = entry.changes[0];
  const value = changes.value;

  if (value.contacts) {
    const contact = value.contacts[0];
    const phoneNumber = `+${contact.wa_id}`;
    const profileName = contact.profile.name;

    const user = await User.findOne({ phoneNumber });
    if (user && profileName) {
      user.profileName = profileName;
      await user.save();
    }
  }

  if (value.messages) {
    const message = value.messages[0];
    const fromNumber = message.from;
    const phoneNumber = `+${fromNumber}`;
    const text = message.text?.body.trim();
    const interactive = message.interactive;

    if (interactive?.type === 'button_reply') {
      userResponses[fromNumber] = interactive.button_reply.id;
    }

    if (!sessions[fromNumber]) sessions[fromNumber] = { action: null };

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
          await sendMessage(fromNumber, '*Error*\nInvalid property selection. Please reply with a valid number.');
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
          await sendMessage(fromNumber, '*Error*\nInvalid tenant selection. Please reply with a valid number.');
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
          await sendMessage(fromNumber, '*Error*\nInvalid property selection. Please reply with a valid number.');
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
          await sendMessage(fromNumber, '*Error*\nInvalid unit selection. Please reply with a valid number.');
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
          await sendMessage(fromNumber, '*Error*\nInvalid tenant selection. Please reply with a valid number.');
        }
      } else if (sessions[fromNumber].action === 'rent_paid') {
        const tenantId = text.trim();
        const tenant = await Tenant.findOne({ tenant_id: tenantId });
        if (tenant) {
          tenant.status = 'paid';
          await tenant.save();
          await sendMessage(fromNumber, `*Rent Payment Confirmed*\nPayment confirmed for Tenant ID: ${tenantId}.`);
          sessions[fromNumber].action = null;
        } else {
          await sendMessage(fromNumber, `*Error*\nTenant with ID "${tenantId}" not found.`);
        }
      } else if (text.toLowerCase() === 'help') {
        sessions[fromNumber].action = null;
        const buttonMenu = {
          messaging_product: 'whatsapp',
          to: fromNumber,
          type: 'interactive',
          interactive: {
            type: 'button',
            header: { type: 'text', text: 'Help Menu' },
            body: { text: '*Choose an Option*\nPlease select an action below:' },
            footer: { text: 'Rental Management App' },
            action: {
              buttons: [
                { type: 'reply', reply: { id: 'account_info', title: 'Account Info' } },
                { type: 'reply', reply: { id: 'manage', title: 'Manage' } },
                { type: 'reply', reply: { id: 'transactions', title: 'Transactions' } },
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
        const aiResponse = await getGroqAIResponse(query, fromNumber, true);
        await sendMessage(fromNumber, aiResponse);
      } else if (!sessions[fromNumber].action) {
        const aiResponse = await getGroqAIResponse(text, fromNumber, false);
        await sendMessage(fromNumber, aiResponse);
      }
    }

    if (interactive) {
      const selectedOption = interactive.button_reply.id;

      if (sessions[fromNumber].action === 'confirm_property_removal' && selectedOption === 'yes_remove_property') {
        const property = sessions[fromNumber].propertyToRemove;
        await Property.findByIdAndDelete(property._id);
        await sendMessage(fromNumber, `*Property Deleted*\nProperty "${property.name}" has been successfully deleted.`);
        sessions[fromNumber].action = null;
        delete sessions[fromNumber].propertyToRemove;
      } else if (sessions[fromNumber].action === 'confirm_property_removal' && selectedOption === 'no_remove_property') {
        await sendMessage(fromNumber, `*Cancellation*\nProperty "${sessions[fromNumber].propertyToRemove.name}" removal canceled.`);
        sessions[fromNumber].action = null;
        delete sessions[fromNumber].propertyToRemove;
      } else if (sessions[fromNumber].action === 'confirm_unit_removal' && selectedOption === 'yes_remove_unit') {
        const unit = sessions[fromNumber].unitToRemove;
        await Unit.findByIdAndDelete(unit._id);
        await sendMessage(fromNumber, `*Unit Deleted*\nUnit "${unit.unitNumber}" has been successfully deleted.`);
        sessions[fromNumber].action = null;
        delete sessions[fromNumber].unitToRemove;
      } else if (sessions[fromNumber].action === 'confirm_unit_removal' && selectedOption === 'no_remove_unit') {
        await sendMessage(fromNumber, `*Cancellation*\nUnit "${sessions[fromNumber].unitToRemove.unitNumber}" removal canceled.`);
        sessions[fromNumber].action = null;
        delete sessions[fromNumber].unitToRemove;
      } else if (sessions[fromNumber].action === 'confirm_tenant_removal' && selectedOption === 'yes_remove_tenant') {
        const tenant = sessions[fromNumber].tenantToRemove;
        await Tenant.findByIdAndDelete(tenant._id);
        await sendMessage(fromNumber, `*Tenant Deleted*\nTenant "${tenant.name}" has been successfully deleted.`);
        sessions[fromNumber].action = null;
        delete sessions[fromNumber].tenantToRemove;
      } else if (sessions[fromNumber].action === 'confirm_tenant_removal' && selectedOption === 'no_remove_tenant') {
        await sendMessage(fromNumber, `*Cancellation*\nTenant "${sessions[fromNumber].tenantToRemove.name}" removal canceled.`);
        sessions[fromNumber].action = null;
        delete sessions[fromNumber].tenantToRemove;
      } else if (selectedOption === 'account_info') {
        const user = await User.findOne({ phoneNumber });
        if (user) {
          await sendMessage(fromNumber, `*Account Information*\n- Phone: ${user.phoneNumber}\n- Verified: ${user.verified ? 'Yes' : 'No'}\n- Name: ${user.profileName || 'N/A'}\n- Registered: ${user.registrationDate?.toLocaleString() || 'N/A'}`);
        } else {
          await sendMessage(fromNumber, '*Account Information*\nNo account found for this number.');
        }
      } else if (selectedOption === 'manage') {
        await sendManageSubmenu(fromNumber);
      } else if (selectedOption === 'transactions') {
        sessions[fromNumber].action = 'rent_paid';
        await sendMessage(fromNumber, '*Rent Payment*\nPlease provide the Tenant ID to confirm rent payment.');
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
      } else if (selectedOption === 'add_unit') {
        await sendPropertyLink(fromNumber, 'addunit');
      } else if (selectedOption === 'edit_unit') {
        await sendPropertyLink(fromNumber, 'editunit');
      } else if (selectedOption === 'remove_unit') {
        await promptUnitRemoval(fromNumber);
      } else if (selectedOption === 'add_tenant') {
        await sendPropertyLink(fromNumber, 'addtenant');
      } else if (selectedOption === 'edit_tenant') {
        await promptPropertySelection(fromNumber, 'edittenant');
      } else if (selectedOption === 'remove_tenant') {
        await promptTenantRemoval(fromNumber);
      }
    }
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
      header: { type: 'text', text: 'Manage Options' },
      body: { text: '*Manage Your Rentals*\nPlease select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'manage_properties', title: 'Properties' } },
          { type: 'reply', reply: { id: 'manage_units', title: 'Units' } },
          { type: 'reply', reply: { id: 'manage_tenants', title: 'Tenants' } },
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

async function sendPropertyOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Property Options' },
      body: { text: '*Property Management*\nChoose an action:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_property', title: 'Add Property' } },
          { type: 'reply', reply: { id: 'edit_property', title: 'Edit Property' } },
          { type: 'reply', reply: { id: 'remove_property', title: 'Remove Property' } },
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
      header: { type: 'text', text: 'Unit Options' },
      body: { text: '*Unit Management*\nChoose an action:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_unit', title: 'Add Unit' } },
          { type: 'reply', reply: { id: 'edit_unit', title: 'Edit Unit' } },
          { type: 'reply', reply: { id: 'remove_unit', title: 'Remove Unit' } },
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
      header: { type: 'text', text: 'Tenant Options' },
      body: { text: '*Tenant Management*\nChoose an action:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_tenant', title: 'Add Tenant' } },
          { type: 'reply', reply: { id: 'edit_tenant', title: 'Edit Tenant' } },
          { type: 'reply', reply: { id: 'remove_tenant', title: 'Remove Tenant' } },
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
    await sendMessage(phoneNumber, '*Error*\nUser not found.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, '*Error*\nNo properties found to edit tenants for.');
    return;
  }

  let propertyList = '*Select a Property*\nReply with the number of the property:\n';
  properties.forEach((property, index) => {
    propertyList += `${index + 1}. ${property.name} (Address: ${property.address})\n`;
  });
  await sendMessage(phoneNumber, propertyList);
  sessions[phoneNumber] = { action: 'select_property', properties };
}

async function promptTenantSelection(phoneNumber, action, propertyId) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '*Error*\nUser not found.');
    return;
  }

  const tenants = await Tenant.find({ userId: user._id })
    .populate('unitAssigned')
    .then(tenants => tenants.filter(tenant => tenant.unitAssigned && tenant.unitAssigned.property.toString() === propertyId.toString()));

  if (!tenants.length) {
    await sendMessage(phoneNumber, '*Error*\nNo tenants found for this property.');
    return;
  }

  let tenantList = '*Select a Tenant*\nReply with the number of the tenant:\n';
  tenants.forEach((tenant, index) => {
    tenantList += `${index + 1}. ${tenant.name} (ID: ${tenant.tenant_id || tenant._id})\n`;
  });
  await sendMessage(phoneNumber, tenantList);
  sessions[phoneNumber].tenants = tenants;
}

async function sendPropertyLink(phoneNumber, action, tenantId = null) {
  let authorizeRecord = await Authorize.findOne({ phoneNumber: `+${phoneNumber}` }) || new Authorize({
    phoneNumber: `+${phoneNumber}`,
    used: false,
    action,
    createdAt: new Date(),
  });
  authorizeRecord.action = action;
  authorizeRecord.used = false;
  await authorizeRecord.save();

  const baseUrl = `${GLITCH_HOST}/authorize/${authorizeRecord._id}`;
  const longUrl = tenantId ? `${baseUrl}?tenantId=${tenantId}` : baseUrl;
  const shortUrl = await shortenUrl(longUrl);
  await sendMessage(phoneNumber, `*Action Link*\nPlease proceed with the following link:\n${shortUrl}`);
}

async function promptPropertyRemoval(phoneNumber) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '*Error*\nUser not found.');
    return;
  }

  const properties = await Property.find({ userId: user._id });
  if (!properties.length) {
    await sendMessage(phoneNumber, '*Error*\nNo properties found to remove.');
    return;
  }

  let propertyList = '*Select a Property to Remove*\nReply with the number of the property:\n';
  properties.forEach((property, index) => {
    propertyList += `${index + 1}. ${property.name} (Address: ${property.address})\n`;
  });
  await sendMessage(phoneNumber, propertyList);
  sessions[phoneNumber] = { action: 'select_property_to_remove', properties };
}

async function confirmPropertyRemoval(phoneNumber, property) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '*Error*\nUser not found.');
    return;
  }

  const units = await Unit.find({ property: property._id });
  if (units.length > 0) {
    await sendMessage(phoneNumber, `*Error*\nUnits are defined under "${property.name}". Please remove the units first.`);
    sessions[phoneNumber].action = null;
    return;
  }

  const confirmationMessage = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `*Confirm Removal*\nAre you sure you want to remove "${property.name}"?\n*WARNING*: This action is permanent.` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_remove_property', title: 'Yes' } },
          { type: 'reply', reply: { id: 'no_remove_property', title: 'No' } },
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
    await sendMessage(phoneNumber, '*Error*\nUser not found.');
    return;
  }

  const units = await Unit.find({ userId: user._id });
  if (!units.length) {
    await sendMessage(phoneNumber, '*Error*\nNo units found to remove.');
    return;
  }

  let unitList = '*Select a Unit to Remove*\nReply with the number of the unit:\n';
  units.forEach((unit, index) => {
    unitList += `${index + 1}. ${unit.unitNumber} (ID: ${unit.unit_id || unit._id})\n`;
  });
  await sendMessage(phoneNumber, unitList);
  sessions[phoneNumber] = { action: 'select_unit_to_remove', units };
}

async function confirmUnitRemoval(phoneNumber, unit) {
  const user = await User.findOne({ phoneNumber: `+${phoneNumber}` });
  if (!user) {
    await sendMessage(phoneNumber, '*Error*\nUser not found.');
    return;
  }

  const tenants = await Tenant.find({ unitAssigned: unit._id });
  if (tenants.length > 0) {
    await sendMessage(phoneNumber, `*Error*\nTenants are assigned to "${unit.unitNumber}". Please remove the tenants first.`);
    sessions[phoneNumber].action = null;
    return;
  }

  const confirmationMessage = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `*Confirm Removal*\nAre you sure you want to remove "${unit.unitNumber}"?\n*WARNING*: This action is permanent.` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_remove_unit', title: 'Yes' } },
          { type: 'reply', reply: { id: 'no_remove_unit', title: 'No' } },
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
    await sendMessage(phoneNumber, '*Error*\nUser not found.');
    return;
  }

  const tenants = await Tenant.find({ userId: user._id });
  if (!tenants.length) {
    await sendMessage(phoneNumber, '*Error*\nNo tenants found to remove.');
    return;
  }

  let tenantList = '*Select a Tenant to Remove*\nReply with the number of the tenant:\n';
  tenants.forEach((tenant, index) => {
    tenantList += `${index + 1}. ${tenant.name} (ID: ${tenant.tenant_id || tenant._id})\n`;
  });
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
      body: { text: `*Confirm Removal*\nAre you sure you want to remove "${tenant.name}"?\n*WARNING*: This action is permanent.` },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'yes_remove_tenant', title: 'Yes' } },
          { type: 'reply', reply: { id: 'no_remove_tenant', title: 'No' } },
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

//module.exports = { router, sendMessage };
// Export the module
module.exports = {
  router,
  userResponses,
  sessions,
  sendMessage,
};