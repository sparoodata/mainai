// routes/webhook.js
const express  = require('express');
require('../models/Unit');
require('../models/Property');
require('../models/Tenant');
const axios = require('axios');
const User = require('../models/User');
const menuHelpers = require('../helpers/menuHelpers');
const { sendMessage } = require('../helpers/whatsapp');
const { askAI }      = require('../helpers/ai');
const { jsonToTableImage } = require('../helpers/tableImage');
const { jsonToTableText }  = require('../helpers/tableText'); 
const { jsonToHTMLTablePDF } = require('../helpers/tablePdf');
const { uploadToWhatsApp } = require('../helpers/pdfHelpers');
const crypto = require('crypto');
const redis = require('../services/redis');
const analytics = require('../helpers/analytics');
const { jobQueue } = require('../services/queue');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET;

// Track conversational context for property/unit flows
async function getState(prefix, phone) {
  const data = await redis.get(`${prefix}:${phone}`);
  return data ? JSON.parse(data) : undefined;
}

async function setState(prefix, phone, value) {
  await redis.set(`${prefix}:${phone}`, JSON.stringify(value));
}

async function deleteState(prefix, phone) {
  await redis.del(`${prefix}:${phone}`);
}

const SESSION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

async function clearSession(phone) {
  const prefixes = ['reg', 'resp', 'propAdd', 'propEdit', 'unitAdd', 'unitEdit', 'tenantAdd', 'tenantEdit'];
  await Promise.all(prefixes.map(p => deleteState(p, phone)));
}

async function checkTimeout(from, phone) {
  const last = await redis.get(`last:${from}`);
  if (last && Date.now() - parseInt(last, 10) > SESSION_TIMEOUT_MS) {
    await clearSession(phone);
    await redis.del(`last:${from}`);
    await sendMessage(from, 'Timedout, please try again');
    return true;
  }
  return false;
}

async function updateLastActivity(from) {
  await redis.set(`last:${from}`, Date.now());
}

// Interactive Welcome Menu
async function sendWelcomeMenu(to) {
  await analytics.track('welcome_menu', { to });
  const welcome = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🏠 Welcome to Teraa Assistant' },
      body: {
        text: `Hi there! 👋\n\n*Teraa Assistant* is your personal rental management assistant on WhatsApp.\n\nWith Teraa, you can:\n• Track rent payments\n• Get payment alerts\n• Manage units & tenants\n• Store data securely\n\nLet’s get started! 🚀`
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'start_registration', title: '📝 Register Now' } },
          { type: 'reply', reply: { id: 'learn_more', title: 'ℹ️ Learn More' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, welcome, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// Registration Success
async function sendRegistrationSuccess(to) {
  await analytics.track('registration_success', { to });
  const msg = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '✅ Registration Successful!' },
      body: {
        text: `You're now registered on *Teraa Assistant*! 🎉\n\n🔐 Plan: Free (4 units)\n📈 Basic Reports\n📩 Reminders\n\nUpgrade anytime from *Settings* in Main Menu.`
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'main_menu', title: '🏠 Main Menu' } },
          { type: 'reply', reply: { id: 'upgrade_premium', title: '🚀 Upgrade' } },
          { type: 'reply', reply: { id: 'help_support', title: '❓ Help' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, msg, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// Generic List Sender
async function sendList(to, type, title, rows) {
  const message = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: title },
      body: { text: title },
      footer: { text: 'Teraa Assistant' },
      action: {
        button: `Select ${type}`,
        sections: [{ title: `${type}s`, rows }]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, message, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

const languageRows = [
  { id: 'lang_english', title: 'English' },
  { id: 'lang_hindi', title: 'Hindi' },
  { id: 'lang_telugu', title: 'Telugu' },
  { id: 'lang_tamil', title: 'Tamil' },
  { id: 'lang_malayalam', title: 'Malayalam' },
  { id: 'lang_kannada', title: 'Kannada' }
];

const countryRows = [
  { id: 'country_India', title: 'India' }
];

const stateRows = [
  { id: 'state_Telangana', title: 'Telangana' },
  { id: 'state_AndhraPradesh', title: 'Andhra Pradesh' },
  { id: 'state_Karnataka', title: 'Karnataka' },
  { id: 'state_Tamilnadu', title: 'Tamil Nadu' },
  { id: 'state_Kerala', title: 'Kerala' },
  { id: 'state_Delhi', title: 'Delhi' },
  { id: 'state_Maharashtra', title: 'Maharashtra' }
];

// Verification endpoint
router.get('/', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Webhook Handler
router.post('/', asyncHandler(async (req, res) => {
  if (WHATSAPP_APP_SECRET) {
    const sig = req.headers['x-hub-signature-256'];
    const expected = 'sha256=' + crypto.createHmac('sha256', WHATSAPP_APP_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');
    if (sig !== expected) return res.status(401).send('Invalid signature');
  }
  const entry       = req.body.entry?.[0];
  const msg         = entry?.changes?.[0]?.value?.messages?.[0];
  const from        = msg?.from;
  const phone       = `+${from}`;
  const text        = msg?.text?.body?.trim();
  const interactive = msg?.interactive;

  if (from) {
    if (await checkTimeout(from, phone)) {
      return res.sendStatus(200);
    }
    await updateLastActivity(from);
  }
  
  /* ───────── AI queries that start with "\" ───────── */
/* ───────── AI queries that start with "\" ───────── */
/* ───────── AI queries that start with "\" ───────── */
/* ───────── AI queries that start with "\" ───────── */
/* ───────── AI queries that start with "\" ───────── */
/* ───────── AI queries that start with "\" ───────── */
/* ───────── AI queries that start with "\" ───────── */
if (text && text.startsWith('\\')) {
  const aiQuery = text.slice(1).trim();

  if (!aiQuery) {
    await sendMessage(from, 'Please type something after “\\”.');
    return res.sendStatus(200);
  }

  await jobQueue.add('ai-report', { from, aiQuery });
  await sendMessage(from, '⏳ Generating your report, please wait...');
  return res.sendStatus(200);
}
/* ─────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────── */
  
  
  if (!from) return res.sendStatus(200);

  if (interactive?.button_reply) await setState('resp', phone, interactive.button_reply.id);
  if (interactive?.list_reply)   await setState('resp', phone, interactive.list_reply.id);
  const selected = await getState('resp', phone);

  const user = await User.findOne({ phoneNumber: phone });

  const addPropState  = user ? await getState('propAdd', phone) : undefined;
  const editPropState = user ? await getState('propEdit', phone) : undefined;
  const addUnitState   = user ? await getState('unitAdd', phone) : undefined;
  const editUnitState  = user ? await getState('unitEdit', phone) : undefined;
  const addTenantState = user ? await getState('tenantAdd', phone) : undefined;
  const editTenantState= user ? await getState('tenantEdit', phone) : undefined;

  if (user && addPropState && text) {
    const { isValidName, isValidAddress, isValidUnits } = require('../helpers/validators');
    switch (addPropState.step) {
      case 'name':
        if (!isValidName(text)) { await sendMessage(from, '⚠️ Invalid property name. Try again.'); break; }
        addPropState.data.name = text;
        addPropState.step = 'address';
        await sendMessage(from, 'Enter the property address:');
        break;
      case 'address':
        if (!isValidAddress(text)) { await sendMessage(from, '⚠️ Invalid address. Try again.'); break; }
        addPropState.data.address = text;
        addPropState.step = 'units';
        await sendMessage(from, 'How many units does this property have?');
        break;
      case 'units':
        if (!isValidUnits(text)) { await sendMessage(from, '⚠️ Enter a valid number of units.'); break; }
        addPropState.data.totalUnits = parseInt(text);
        const Property = require('../models/Property');
        await new Property(addPropState.data).save();
        await sendMessage(from, '✅ Property added successfully.');
        await deleteState('propAdd', phone);
        return res.sendStatus(200);
    }
    await setState('propAdd', phone, addPropState);
    return res.sendStatus(200);
  }

  if (user && editPropState && text) {
    const { isValidName, isValidAddress, isValidUnits } = require('../helpers/validators');
    const Property = require('../models/Property');
    const property = await Property.findOne({ _id: editPropState.propId, ownerId: user._id });
    if (!property) {
      await sendMessage(from, '⚠️ Property not found.');
      await deleteState('propEdit', phone);
      return res.sendStatus(200);
    }

    switch (editPropState.step) {
      case 'name':
        if (text.toLowerCase() !== 'skip') {
          if (!isValidName(text)) { await sendMessage(from, '⚠️ Invalid property name. Try again.'); return res.sendStatus(200); }
          editPropState.data.name = text;
        }
        editPropState.step = 'address';
        await sendMessage(from, 'Enter new address or type "skip":');
        await setState('propEdit', phone, editPropState);
        return res.sendStatus(200);
      case 'address':
        if (text.toLowerCase() !== 'skip') {
          if (!isValidAddress(text)) { await sendMessage(from, '⚠️ Invalid address. Try again.'); return res.sendStatus(200); }
          editPropState.data.address = text;
        }
        editPropState.step = 'units';
        await sendMessage(from, 'Enter new total units or type "skip":');
        await setState('propEdit', phone, editPropState);
        return res.sendStatus(200);
      case 'units':
        if (text.toLowerCase() !== 'skip') {
          if (!isValidUnits(text)) { await sendMessage(from, '⚠️ Invalid units.'); return res.sendStatus(200); }
          editPropState.data.totalUnits = parseInt(text);
        }
        await Property.updateOne({ _id: editPropState.propId, ownerId: user._id }, editPropState.data);
        await sendMessage(from, '✅ Property updated successfully.');
        await deleteState('propEdit', phone);
        return res.sendStatus(200);
    }
  }

  if (user && addUnitState && text) {
    const Property = require('../models/Property');
    const Unit = require('../models/Unit');
    switch (addUnitState.step) {
      case 'property': {
        const { isValidObjectId } = require('../helpers/validators');
        if (!isValidObjectId(text)) {
          await sendMessage(from, '⚠️ Invalid property ID. Try again.');
          break;
        }
        const prop = await Property.findOne({ _id: text, ownerId: user._id });
        if (!prop) { await sendMessage(from, '⚠️ Invalid property ID. Try again.'); break; }
        addUnitState.data.property = prop._id;
        addUnitState.step = 'number';
        await sendMessage(from, 'Enter unit number:');
        break; }
      case 'number':
        addUnitState.data.unitNumber = text;
        addUnitState.step = 'rent';
        await sendMessage(from, 'Enter monthly rent amount:');
        break;
      case 'rent': {
        const rent = parseFloat(text);
        if (isNaN(rent)) { await sendMessage(from, '⚠️ Invalid rent amount.'); break; }
        addUnitState.data.rentAmount = rent;
        await new Unit(addUnitState.data).save();
        await sendMessage(from, '✅ Unit added successfully.');
        await deleteState('unitAdd', phone);
        return res.sendStatus(200); }
    }
    await setState('unitAdd', phone, addUnitState);
    return res.sendStatus(200);
  }

  if (user && editUnitState && text) {
    const Unit = require('../models/Unit');
    const unit = await Unit.findById(editUnitState.unitId).populate('property');
    if (!unit || String(unit.property.ownerId) !== String(user._id)) {
      await sendMessage(from, '⚠️ Unit not found.');
      await deleteState('unitEdit', phone);
      return res.sendStatus(200);
    }
    switch (editUnitState.step) {
      case 'number':
        if (text.toLowerCase() !== 'skip') {
          editUnitState.data.unitNumber = text;
        }
        editUnitState.step = 'rent';
        await sendMessage(from, 'Enter new rent or type "skip":');
        await setState('unitEdit', phone, editUnitState);
        return res.sendStatus(200);
      case 'rent':
        if (text.toLowerCase() !== 'skip') {
          const rent = parseFloat(text);
          if (isNaN(rent)) { await sendMessage(from, '⚠️ Invalid rent.'); return res.sendStatus(200); }
          editUnitState.data.rentAmount = rent;
        }
        await Unit.updateOne({ _id: editUnitState.unitId }, editUnitState.data);
        await sendMessage(from, '✅ Unit updated successfully.');
        await deleteState('unitEdit', phone);
        return res.sendStatus(200);
    }
  }

  if (user && addTenantState && text) {
    const Unit = require('../models/Unit');
    const Tenant = require('../models/Tenant');
    switch (addTenantState.step) {
      case 'unit': {
        const { isValidObjectId } = require('../helpers/validators');
        if (!isValidObjectId(text)) {
          await sendMessage(from, '⚠️ Invalid unit ID. Try again.');
          break;
        }
        const unit = await Unit.findById(text).populate('property');
        if (!unit || String(unit.property.ownerId) !== String(user._id)) {
          await sendMessage(from, '⚠️ Invalid unit ID. Try again.');
          break;
        }
        addTenantState.data.unitAssigned = unit._id;
        addTenantState.step = 'name';
        await sendMessage(from, 'Enter tenant full name:');
        break; }
      case 'name':
        addTenantState.data.fullName = text;
        addTenantState.step = 'phone';
        await sendMessage(from, 'Enter tenant phone number:');
        break;
      case 'phone':
        addTenantState.data.phoneNumber = text;
        await new Tenant(addTenantState.data).save();
        await sendMessage(from, '✅ Tenant added successfully.');
        await deleteState('tenantAdd', phone);
        return res.sendStatus(200);
    }
    await setState('tenantAdd', phone, addTenantState);
    return res.sendStatus(200);
  }

  if (user && editTenantState && text) {
    const Tenant = require('../models/Tenant');
    const tenant = await Tenant.findById(editTenantState.tenantId)
      .populate({ path: 'unitAssigned', populate: { path: 'property' } });
    if (!tenant || String(tenant.unitAssigned.property.ownerId) !== String(user._id)) {
      await sendMessage(from, '⚠️ Tenant not found.');
      await deleteState('tenantEdit', phone);
      return res.sendStatus(200);
    }
    switch (editTenantState.step) {
      case 'name':
        if (text.toLowerCase() !== 'skip') {
          editTenantState.data.fullName = text;
        }
        editTenantState.step = 'phone';
        await sendMessage(from, 'Enter new phone number or type "skip":');
        await setState('tenantEdit', phone, editTenantState);
        return res.sendStatus(200);
      case 'phone':
        if (text.toLowerCase() !== 'skip') {
          editTenantState.data.phoneNumber = text;
        }
        await Tenant.updateOne({ _id: editTenantState.tenantId }, editTenantState.data);
        await sendMessage(from, '✅ Tenant updated successfully.');
        await deleteState('tenantEdit', phone);
        return res.sendStatus(200);
    }
  }

  // New user: 'start' or 'help'
  if (!user && (text === 'start' || text === 'help')) {
    await sendWelcomeMenu(from);
    return res.sendStatus(200);
  }

  // Registered user menu actions
  if (user) {
    switch (selected) {
      case 'main_menu':
      case undefined:
        await menuHelpers.sendMainMenu(from, user.subscription);
        break;

case 'manage_properties':
  await menuHelpers.sendPropertiesManagementMenu(from); break;
case 'manage_units':
  await menuHelpers.sendUnitsManagementMenu(from); break;
case 'manage_tenants':
  await menuHelpers.sendTenantsManagementMenu(from); break;
case 'standard_reports':
case 'ai_reports':
  await menuHelpers.sendReportsMenu(from); break; 
      case 'add_unit':
        await setState('unitAdd', phone, { step: 'property', data: {} });
        await sendMessage(from, 'Enter property ID for the unit:');
        break;

      case 'edit_unit': {
        const Unit = require('../models/Unit');
        const units = await Unit.find().populate('property');
        const list = units.filter(u => String(u.property.ownerId) === String(user._id));
        if (!list.length) {
          await sendMessage(from, 'No units found.');
        } else {
          await menuHelpers.sendUnitSelectionMenu(from, list, 'edit_unit', 'Select unit to edit');
        }
        break; }

      case 'remove_unit': {
        const Unit = require('../models/Unit');
        const units = await Unit.find().populate('property');
        const list = units.filter(u => String(u.property.ownerId) === String(user._id));
        if (!list.length) {
          await sendMessage(from, 'No units found.');
        } else {
          await menuHelpers.sendUnitSelectionMenu(from, list, 'delete_unit', 'Select unit to remove');
        }
        break; }

      case 'add_property':
        await setState('propAdd', phone, { step: 'name', data: { ownerId: user._id } });
        await menuHelpers.promptAddProperty(from);
        break;

      case 'edit_property': {
        const Property = require('../models/Property');
        const props = await Property.find({ ownerId: user._id });
        if (!props.length) {
          await sendMessage(from, 'No properties found.');
        } else {
          await menuHelpers.sendPropertySelectionMenu(from, props, 'edit_prop', 'Select property to edit');
        }
        break; }

      case 'remove_property': {
        const Property = require('../models/Property');
        const props = await Property.find({ ownerId: user._id });
        if (!props.length) {
          await sendMessage(from, 'No properties found.');
        } else {
          await menuHelpers.sendPropertySelectionMenu(from, props, 'delete_prop', 'Select property to remove');
        }
        break; }

      case 'view_tenants':
        await menuHelpers.sendTenantsMenu(from);
        break;

      case 'add_tenant':
        await setState('tenantAdd', phone, { step: 'unit', data: {} });
        await sendMessage(from, 'Enter unit ID for the tenant:');
        break;

      case 'edit_tenant': {
        const Tenant = require('../models/Tenant');
        const tenants = await Tenant.find().populate({ path: 'unitAssigned', populate: { path: 'property' } });
        const list = tenants.filter(t => String(t.unitAssigned.property.ownerId) === String(user._id));
        if (!list.length) {
          await sendMessage(from, 'No tenants found.');
        } else {
          await menuHelpers.sendTenantSelectionMenu(from, list, 'edit_tenant', 'Select tenant to edit');
        }
        break; }

      case 'remove_tenant': {
        const Tenant = require('../models/Tenant');
        const tenants = await Tenant.find().populate({ path: 'unitAssigned', populate: { path: 'property' } });
        const list = tenants.filter(t => String(t.unitAssigned.property.ownerId) === String(user._id));
        if (!list.length) {
          await sendMessage(from, 'No tenants found.');
        } else {
          await menuHelpers.sendTenantSelectionMenu(from, list, 'delete_tenant', 'Select tenant to remove');
        }
        break; }

      case 'record_payment':
        await menuHelpers.promptRecordPayment(from);
        break;

      case 'payment_history':
        await menuHelpers.sendPaymentHistory(from);
        break;

      case 'setup_reminders':
        await menuHelpers.sendRemindersMenu(from);
        break;

      case 'settings':
        await menuHelpers.sendSettingsMenu(from);
        break;

      case 'upgrade_premium':
        if (user.subscription === 'premium') {
          await sendMessage(from, '🎉 You are already a Premium subscriber!');
        } else {
          await axios.get(
            `${process.env.GLITCH_HOST}/pay/${encodeURIComponent(phone)}`
          );
        }
        break;

      case 'help_support':
        await sendMessage(
          from,
          '💬 Our support team will reach out soon or email support@teraa.ai'
        );
        break;

      default:
        if (selected && selected.startsWith('edit_prop_')) {
          const propId = selected.replace('edit_prop_', '');
          await setState('propEdit', phone, { step: 'name', propId, data: {} });
          const Property = require('../models/Property');
          const prop = await Property.findOne({ _id: propId, ownerId: user._id });
          if (prop) {
            await sendMessage(from, `Editing *${prop.name}*\nSend new name or type "skip":`);
          } else {
            await sendMessage(from, 'Property not found.');
          }
        } else if (selected && selected.startsWith('delete_prop_')) {
          const propId = selected.replace('delete_prop_', '');
          const Property = require('../models/Property');
          await Property.deleteOne({ _id: propId, ownerId: user._id });
          await sendMessage(from, '🗑️ Property deleted.');
        } else if (selected && selected.startsWith('edit_unit_')) {
          const unitId = selected.replace('edit_unit_', '');
          await setState('unitEdit', phone, { step: 'number', unitId, data: {} });
          const Unit = require('../models/Unit');
          const unit = await Unit.findById(unitId).populate('property');
          if (unit && String(unit.property.ownerId) === String(user._id)) {
            await sendMessage(from, `Editing unit ${unit.unitNumber}\nSend new number or type "skip":`);
          } else {
            await sendMessage(from, 'Unit not found.');
          }
        } else if (selected && selected.startsWith('delete_unit_')) {
          const unitId = selected.replace('delete_unit_', '');
          const Unit = require('../models/Unit');
          const unit = await Unit.findById(unitId).populate('property');
          if (unit && String(unit.property.ownerId) === String(user._id)) {
            await Unit.deleteOne({ _id: unitId });
            await sendMessage(from, '🗑️ Unit deleted.');
          } else {
            await sendMessage(from, 'Unit not found.');
          }
        } else if (selected && selected.startsWith('edit_tenant_')) {
          const tenantId = selected.replace('edit_tenant_', '');
          await setState('tenantEdit', phone, { step: 'name', tenantId, data: {} });
          const Tenant = require('../models/Tenant');
          const tenant = await Tenant.findById(tenantId)
            .populate({ path: 'unitAssigned', populate: { path: 'property' } });
          if (tenant && String(tenant.unitAssigned.property.ownerId) === String(user._id)) {
            await sendMessage(from, `Editing ${tenant.fullName}\nSend new name or type "skip":`);
          } else {
            await sendMessage(from, 'Tenant not found.');
          }
        } else if (selected && selected.startsWith('delete_tenant_')) {
          const tenantId = selected.replace('delete_tenant_', '');
          const Tenant = require('../models/Tenant');
          const tenant = await Tenant.findById(tenantId)
            .populate({ path: 'unitAssigned', populate: { path: 'property' } });
          if (tenant && String(tenant.unitAssigned.property.ownerId) === String(user._id)) {
            await Tenant.deleteOne({ _id: tenantId });
            await sendMessage(from, '🗑️ Tenant deleted.');
          } else {
            await sendMessage(from, 'Tenant not found.');
          }
        } else {
          await menuHelpers.sendMainMenu(from, user.subscription);
        }
    }

    await deleteState('resp', phone);
    return res.sendStatus(200);
  }

  // Registration flow
  let reg = await getState('reg', phone) || { data: { phoneNumber: phone } };

  if (selected === 'start_registration') {
    reg.step = 'language';
    await sendList(from, 'Language', 'Select language', languageRows);

  } else if (selected && selected.startsWith('lang_') && reg.step === 'language') {
    reg.data.language = selected.replace('lang_', '');
    reg.step = 'country';
    await sendList(from, 'Country', 'Select country', countryRows);

  } else if (selected && selected.startsWith('country_') && reg.step === 'country') {
    reg.data.country = selected.replace('country_', '');
    reg.step = 'email';
    await sendMessage(from, 'Please enter your email:');

  } else if (reg.step === 'email' && text) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      return await sendMessage(from, '⚠️ Invalid email. Try again.');
    }
    reg.data.email = text;
    reg.step = 'age';
    await sendMessage(from, 'How old are you?');

  } else if (reg.step === 'age' && text) {
    const age = parseInt(text);
    if (isNaN(age) || age < 18 || age > 100) {
      return await sendMessage(from, '⚠️ Enter valid age (18–100).');
    }
    reg.data.age = age;
    reg.step = 'state';
    await sendList(from, 'State', 'Select your state', stateRows);

  } else if (selected && selected.startsWith('state_') && reg.step === 'state') {
    reg.data.state = selected.replace('state_', '');
    reg.step = 'newsletter';
    await sendMessage(from, 'Receive newsletter? (yes/no)');

  } else if (reg.step === 'newsletter' && text) {
    const ans = text.toLowerCase();
    if (!['yes', 'no'].includes(ans)) {
      return await sendMessage(from, '⚠️ Reply yes or no.');
    }
    reg.data.newsletter = ans === 'yes';

    // Save new user
    await new User(reg.data).save();
    await deleteState('reg', phone);
    await sendRegistrationSuccess(from);
  }

  await setState('reg', phone, reg);
  return res.sendStatus(200);
}));

module.exports = { router };
