// routes/menuHelpers.js
const axios = require('axios');
const { sendMessage } = require('./whatsapp');
const chunkArray = require('./chunkArray');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Generic List Sender for multi-section lists
async function sendList(to, headerText, sections, buttonLabel = 'Choose') {
  const payload = {
    messaging_product: 'whatsapp', to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: headerText },
      body: { text: headerText },
      footer: { text: 'Teraa Assistant' },
      action: { button: buttonLabel, sections }
    }
  };
  await axios.post(WHATSAPP_API_URL, payload, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// Main Menu
async function sendMainMenu(to) {
  const sections = [
    { title: 'Properties', rows: [
        { id: 'manage_properties', title: '🏠 Manage Properties' },
        { id: 'add_property',      title: '➕ Add Property' }
      ]},
    { title: 'Units', rows: [
        { id: 'manage_units', title: '🏢 Manage Units' },
        { id: 'add_unit',     title: '➕ Add Unit' }
      ]},
    { title: 'Tenants', rows: [
        { id: 'manage_tenants', title: '👥 Manage Tenants' },
        { id: 'add_tenant',     title: '➕ Add Tenant' }
      ]},
    { title: 'Payments', rows: [
        { id: 'record_payment',  title: '💰 Record Payment' },
        { id: 'payment_history', title: '📜 Payment History' }
      ]},
    { title: 'Account', rows: [
        { id: 'settings',        title: '⚙️ Settings' },
        { id: 'support',         title: '🛠️ Support' }
      ]}
  ];
  await sendList(to, '🏠 Main Menu', sections);
}

// Settings Menu (includes Upgrade & Delete Account)
async function sendSettingsMenu(to) {
  const sections = [{ title: 'Settings', rows: [
      { id: 'profile',         title: '👤 Profile' },
      { id: 'notifications',   title: '🔔 Notifications' },
      { id: 'language',        title: '🌐 Language' },
      { id: 'upgrade_premium', title: '🚀 Upgrade to Premium' },
      { id: 'delete_account',  title: '🗑️ Delete My Account' }
  ]}];
  await sendList(to, '⚙️ Settings', sections);
}

// Properties Management (buttons)
async function sendPropertiesManagementMenu(to) {
  const payload = {
    messaging_product: 'whatsapp', to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🏠 Property Options' },
      body: { text: 'What would you like to do with properties?' },
      action: { buttons: [
        { type: 'reply', reply: { id: 'edit_property',   title: '✏️ Edit Property' } },
        { type: 'reply', reply: { id: 'remove_property', title: '🗑️ Remove Property' } },
        { type: 'reply', reply: { id: 'add_property',    title: '➕ Add Property' } }
      ] }
    }
  };
  await axios.post(WHATSAPP_API_URL, payload, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// Units Management (buttons)
async function sendUnitsManagementMenu(to) {
  const payload = {
    messaging_product: 'whatsapp', to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🚪 Unit Options' },
      body: { text: 'What would you like to do with units?' },
      action: { buttons: [
        { type: 'reply', reply: { id: 'edit_unit',   title: '✏️ Edit Unit' } },
        { type: 'reply', reply: { id: 'remove_unit', title: '🗑️ Remove Unit' } },
        { type: 'reply', reply: { id: 'add_unit',    title: '➕ Add Unit' } }
      ] }
    }
  };
  await axios.post(WHATSAPP_API_URL, payload, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// Tenants Management (buttons)
async function sendTenantsManagementMenu(to) {
  const payload = {
    messaging_product: 'whatsapp', to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '👥 Tenant Options' },
      body: { text: 'What would you like to do with tenants?' },
      action: { buttons: [
        { type: 'reply', reply: { id: 'edit_tenant',   title: '✏️ Edit Tenant' } },
        { type: 'reply', reply: { id: 'remove_tenant', title: '🗑️ Remove Tenant' } },
        { type: 'reply', reply: { id: 'add_tenant',    title: '➕ Add Tenant' } }
      ] }
    }
  };
  await axios.post(WHATSAPP_API_URL, payload, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// Property & Unit pagination and other prompts unchanged
async function sendPropertySelectionMenu(to, properties) { /* ... */ }
async function sendUnitSelectionMenu(to, units)         { /* ... */ }
async function promptAddUnit(to)                        { await sendMessage(to, 'Please enter the unit details...'); }
async function promptAddTenant(to)                      { await sendMessage(to, 'Please enter tenant info...'); }
async function promptRecordPayment(to)                  { await sendMessage(to, 'Please enter payment details...'); }
async function sendPaymentHistory(to)                   { /* ... */ }

module.exports = {
  sendMainMenu,
  sendSettingsMenu,
  sendPropertiesManagementMenu,
  sendUnitsManagementMenu,
  sendTenantsManagementMenu,
  sendPropertySelectionMenu,
  sendUnitSelectionMenu,
  promptAddUnit,
  promptAddTenant,
  promptRecordPayment,
  sendPaymentHistory
};
