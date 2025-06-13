// routes/menuHelpers.js
const { sendMessage, api: whatsappApi } = require('./whatsapp');
const chunkArray = require('./chunkArray');

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
  await whatsappApi.post('', payload);
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
  await whatsappApi.post('', payload);
}

// Main Menu
async function sendMainMenu(to) {
  const { track } = require('./analytics');
  await track('main_menu', { to });
  const sections = [
    {
      title: 'Management',
      rows: [
        { id: 'manage_properties', title: '🏠 Property Management' },
        { id: 'manage_units',      title: '🚪 Unit Management' },
        { id: 'manage_tenants',    title: '👥 Tenant Management' }
      ]
    },
    {
      title: 'Financials',
      rows: [
        { id: 'record_payment',  title: '💳 Record Payment' },
        { id: 'payment_history', title: '📜 Payment History' }
      ]
    },
    {
      title: 'Analytics',
      rows: [
        { id: 'standard_reports', title: '📊 Standard Reports' },
        { id: 'ai_reports',       title: '🤖 AI Reports' }
      ]
    },
    {
      title: 'Account & Help',
      rows: [
        { id: 'settings',  title: '⚙️ Account Settings' },
        { id: 'support',   title: '🛠️ Support' }
      ]
    }
  ];
  await sendList(to, '🏠 Main Menu', sections, 'Choose');
}

// Settings Menu (includes Upgrade & Delete Account)
async function sendSettingsMenu(to) {
  const { track } = require('./analytics');
  await track('settings_menu', { to });
  const sections = [
    {
      title: 'Account Settings',
      rows: [
        { id: 'profile',         title: '👤 Profile' },
        { id: 'notifications',   title: '🔔 Notifications' },
        { id: 'language',        title: '🌐 Language' },
        { id: 'upgrade_premium', title: '🚀 Upgrade to Premium' },
        { id: 'delete_account',  title: '🗑️ Delete My Account' }
      ]
    }
  ];
  await sendList(to, '⚙️ Account Settings', sections, 'Choose');
}

// Properties Management (buttons)
async function sendPropertiesManagementMenu(to) {
  const buttons = [
    { type: 'reply', reply: { id: 'edit_property',   title: '✏️ Edit Property' } },
    { type: 'reply', reply: { id: 'remove_property', title: '🗑️ Remove Property' } },
    { type: 'reply', reply: { id: 'add_property',    title: '➕ Add Property' } }
  ];
  await sendButtonMenu(to, '🏠 Property Management', 'Select an action:', buttons);
}

// Units Management (buttons)
async function sendUnitsManagementMenu(to) {
  const buttons = [
    { type: 'reply', reply: { id: 'edit_unit',   title: '✏️ Edit Unit' } },
    { type: 'reply', reply: { id: 'remove_unit', title: '🗑️ Remove Unit' } },
    { type: 'reply', reply: { id: 'add_unit',    title: '➕ Add Unit' } }
  ];
  await sendButtonMenu(to, '🚪 Unit Management', 'Select an action:', buttons);
}

// Tenants Management (buttons)
async function sendTenantsManagementMenu(to) {
  const buttons = [
    { type: 'reply', reply: { id: 'edit_tenant',   title: '✏️ Edit Tenant' } },
    { type: 'reply', reply: { id: 'remove_tenant', title: '🗑️ Remove Tenant' } },
    { type: 'reply', reply: { id: 'add_tenant',    title: '➕ Add Tenant' } }
  ];
  await sendButtonMenu(to, '👥 Tenant Management', 'Select an action:', buttons);
}

// Reports Menu (buttons)
async function sendReportsMenu(to) {
  const buttons = [
    { type: 'reply', reply: { id: 'standard_reports', title: '📊 Standard Reports' } },
    { type: 'reply', reply: { id: 'ai_reports',       title: '🤖 AI Reports' } }
  ];
  await sendButtonMenu(to, '📈 Reports & Analytics', 'Select report type:', buttons);
}

// Generic list for selecting a property
async function sendPropertySelectionMenu(to, properties, prefix, title) {
  const rows = properties.slice(0, 10).map(p => ({ id: `${prefix}_${p._id}`, title: p.name }));
  await sendList(to, title, [{ title: 'Properties', rows }], 'Select');
}

async function promptAddProperty(to) {
  await sendMessage(to, 'Please enter the property name:');
}

// Generic list for selecting a unit
async function sendUnitSelectionMenu(to, units, prefix = 'unit', title = 'Select Unit') {
  const rows = units.slice(0, 10).map(u => ({ id: `${prefix}_${u._id}`, title: u.unitNumber }));
  await sendList(to, title, [{ title: 'Units', rows }], 'Select');
}

// Generic list for selecting a tenant
async function sendTenantSelectionMenu(to, tenants, prefix = 'tenant', title = 'Select Tenant') {
  const rows = tenants.slice(0, 10).map(t => ({ id: `${prefix}_${t._id}`, title: t.fullName }));
  await sendList(to, title, [{ title: 'Tenants', rows }], 'Select');
}

async function promptAddUnit(to)   { await sendMessage(to, 'Please enter the unit details...'); }
async function promptAddTenant(to) { await sendMessage(to, 'Please enter tenant info...'); }
async function promptRecordPayment(to) { await sendMessage(to, 'Please enter payment details...'); }
async function sendPaymentHistory(to) { /* ... */ }

module.exports = {
  sendMainMenu,
  sendSettingsMenu,
  sendPropertiesManagementMenu,
  sendUnitsManagementMenu,
  sendTenantsManagementMenu,
  sendReportsMenu,
  sendPropertySelectionMenu,
  promptAddProperty,
  sendUnitSelectionMenu,
  sendTenantSelectionMenu,
  promptAddUnit,
  promptAddTenant,
  promptRecordPayment,
  sendPaymentHistory
};
