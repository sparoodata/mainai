// routes/menuHelpers.js
const axios = require('axios');
const { sendMessage } = require('./whatsapp');
const chunkArray = require('./chunkArray');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Generic List Sender for multi-section lists
async function sendList(to, headerText, sections, buttonLabel = 'Choose') {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: headerText },
      body: { text: headerText },
      footer: { text: 'Teraa Assistant' },
      action: {
        button: buttonLabel,
        sections: sections  // expect array of { title, rows: [{id, title, description?}] }
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, payload, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// Main Menu
async function sendMainMenu(to) {
  const sections = [
    {
      title: 'Properties',
      rows: [
        { id: 'manage_properties', title: '🏠 Manage Properties' },
        { id: 'add_property',      title: '➕ Add Property' }
      ]
    },
    {
      title: 'Units',
      rows: [
        { id: 'manage_units', title: '🏢 Manage Units' },
        { id: 'add_unit',     title: '➕ Add Unit' }
      ]
    },
    {
      title: 'Tenants',
      rows: [
        { id: 'manage_tenants', title: '👥 Manage Tenants' },
        { id: 'add_tenant',     title: '➕ Add Tenant' }
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
        { id: 'settings',        title: '⚙️ Settings' },
        { id: 'support',         title: '🛠️ Support' }
      ]
    }
  ];
  await sendList(to, '🏠 Main Menu', sections, 'Choose');
}

// Settings Menu (includes Upgrade)
async function sendSettingsMenu(to) {
  const sections = [
    {
      title: 'Settings',
      rows: [
        { id: 'profile',         title: '👤 Profile' },
        { id: 'notifications',   title: '🔔 Notifications' },
        { id: 'language',        title: '🌐 Language' },
        { id: 'upgrade_premium', title: '🚀 Upgrade to Premium' }
      ]
    }
  ];
  await sendList(to, '⚙️ Settings', sections, 'Choose');
}

// Property Selection (paginated list)
async function sendPropertySelectionMenu(to, properties) {
  const chunks = chunkArray(properties, 10);
  for (let i = 0; i < chunks.length; i++) {
    const rows = chunks[i].map(prop => ({
      id: `prop_${prop._id}`,
      title: prop.name.slice(0, 24),
      description: prop.address.slice(0, 72)
    }));
    const sections = [{ title: `Properties (${i + 1}/${chunks.length})`, rows }];
    await sendList(to, '🏠 Select a Property', sections, 'Select');
  }
}

// Unit Selection (paginated list)
async function sendUnitSelectionMenu(to, units) {
  const chunks = chunkArray(units, 10);
  for (let i = 0; i < chunks.length; i++) {
    const rows = chunks[i].map(u => ({
      id: `unit_${u._id}`,
      title: u.unitNumber.slice(0, 24),
      description: (`Floor: ${u.floor}`).slice(0, 72)
    }));
    const sections = [{ title: `Units (${i + 1}/${chunks.length})`, rows }];
    await sendList(to, '🚪 Select a Unit', sections, 'Select');
  }
}

// Prompts and simple actions
async function promptAddUnit(to) {
  await sendMessage(to, 'Please enter the unit details (e.g., 2BHK Apartment at 45 River Street):');
}
async function promptAddTenant(to) {
  await sendMessage(to, 'Please enter tenant info (Name, Unit, Rent amount, e.g., John Doe, Apt 3A, ₹12000):');
}
async function promptRecordPayment(to) {
  await sendMessage(to, 'Please enter payment details (Tenant, Unit, Amount, Date, e.g., John Doe, Apt 3A, ₹12000, 2025-06-01):');
}
async function sendPaymentHistory(to) {
  const sections = [{ title: 'Payment History', rows: [
    { id: 'history_5', title: '🗓️ Last 5 Payments' }
  ] }];
  await sendList(to, '📜 Payment History', sections, 'Choose');
}

module.exports = {
  sendMainMenu,
  sendSettingsMenu,
  sendPropertySelectionMenu,
  sendUnitSelectionMenu,
  promptAddUnit,
  promptAddTenant,
  promptRecordPayment,
  sendPaymentHistory
};