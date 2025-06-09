// routes/menuHelpers.js
const axios = require('axios');
const { sendMessage } = require('./whatsapp');
const chunkArray = require('./chunkArray');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Generic List Sender for multi-section lists (no header shown)
async function sendList(to, headerText, sections, buttonLabel = 'Choose') {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: headerText }, // Only body text; header removed
      footer: { text: 'Teraa Assistant' },
      action: { button: buttonLabel, sections }
    }
  };
  await axios.post(WHATSAPP_API_URL, payload, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// Generic Button Menu (no header shown). `headerText` is ignored
async function sendButtonMenu(to, headerText, bodyText, buttons) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: { buttons }
    }
  };
  await axios.post(WHATSAPP_API_URL, payload, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// Main Menu
async function sendMainMenu(to) {
  const sections = [
    {
      title: 'Manage',
      rows: [
        { id: 'manage_properties', title: '🏠 Properties' },
        { id: 'manage_units',      title: '🏢 Units' },
        { id: 'manage_tenants',    title: '👥 Tenants' }
      ]
    },
    {
      title: 'Reports',
      rows: [
        { id: 'standard_reports', title: '📊 Standard Reports' },
        { id: 'ai_reports',       title: '🤖 AI Reports' }
      ]
    },
    {
      title: 'Payments',
      rows: [
        { id: 'record_payment',  title: '💰 Record Payment' },
        { id: 'payment_history', title: '📜 Payment History' }
      ]
    },
    {
      title: 'Account',
      rows: [
        { id: 'settings',  title: '⚙️ Settings' },
        { id: 'support',   title: '🛠️ Support' }
      ]
    }
  ];
  await sendList(to, '🏠 Main Menu', sections, 'Choose');
}

// Settings Menu (includes Upgrade & Delete Account)
async function sendSettingsMenu(to) {
  const sections = [
    {
      title: 'Settings',
      rows: [
        { id: 'profile',         title: '👤 Profile' },
        { id: 'notifications',   title: '🔔 Notifications' },
        { id: 'language',        title: '🌐 Language' },
        { id: 'upgrade_premium', title: '🚀 Upgrade to Premium' },
        { id: 'delete_account',  title: '🗑️ Delete My Account' }
      ]
    }
  ];
  await sendList(to, '⚙️ Settings', sections, 'Choose');
}

// Properties Management (buttons)
async function sendPropertiesManagementMenu(to) {
  const buttons = [
    { type: 'reply', reply: { id: 'edit_property',   title: '✏️ Edit Property' } },
    { type: 'reply', reply: { id: 'remove_property', title: '🗑️ Remove Property' } },
    { type: 'reply', reply: { id: 'add_property',    title: '➕ Add Property' } }
  ];
  await sendButtonMenu(to, '🏠 Property Options', 'Choose an action for properties:', buttons);
}

// Units Management (buttons)
async function sendUnitsManagementMenu(to) {
  const buttons = [
    { type: 'reply', reply: { id: 'edit_unit',   title: '✏️ Edit Unit' } },
    { type: 'reply', reply: { id: 'remove_unit', title: '🗑️ Remove Unit' } },
    { type: 'reply', reply: { id: 'add_unit',    title: '➕ Add Unit' } }
  ];
  await sendButtonMenu(to, '🚪 Unit Options', 'Choose an action for units:', buttons);
}

// Tenants Management (buttons)
async function sendTenantsManagementMenu(to) {
  const buttons = [
    { type: 'reply', reply: { id: 'edit_tenant',   title: '✏️ Edit Tenant' } },
    { type: 'reply', reply: { id: 'remove_tenant', title: '🗑️ Remove Tenant' } },
    { type: 'reply', reply: { id: 'add_tenant',    title: '➕ Add Tenant' } }
  ];
  await sendButtonMenu(to, '👥 Tenant Options', 'Choose an action for tenants:', buttons);
}

// Reports Menu (buttons)
async function sendReportsMenu(to) {
  const buttons = [
    { type: 'reply', reply: { id: 'standard_reports', title: '📊 Standard Reports' } },
    { type: 'reply', reply: { id: 'ai_reports',       title: '🤖 AI Reports' } }
  ];
  await sendButtonMenu(to, '📈 Reports', 'Select report type:', buttons);
}

// Property & Unit pagination and other prompts unchanged\async function sendPropertySelectionMenu(to, properties) { /* ... */ }
async function sendUnitSelectionMenu(to, units)           { /* ... */ }
async function promptAddUnit(to)                          { await sendMessage(to, 'Please enter the unit details...'); }
async function promptAddTenant(to)                        { await sendMessage(to, 'Please enter tenant info...'); }
async function promptRecordPayment(to)                    { await sendMessage(to, 'Please enter payment details...'); }
async function sendPaymentHistory(to)                     { /* ... */ }

module.exports = {
  sendMainMenu,
  sendSettingsMenu,
  sendPropertiesManagementMenu,
  sendUnitsManagementMenu,
  sendTenantsManagementMenu,
  sendReportsMenu,
  sendUnitSelectionMenu,
  promptAddUnit,
  promptAddTenant,
  promptRecordPayment,
  sendPaymentHistory
};
