const axios = require('axios');
const { sendMessage } = require('./whatsapp');
const chunkArray = require('./chunkArray');
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

async function sendPropertySelectionMenu(phoneNumber, properties) {
  const chunks = chunkArray(properties, 10);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const sectionTitle = `Properties ${i + 1}/${chunks.length}`;
    const rows = chunk.map((prop) => ({
      id: `chunk${i}_${prop._id}`,
      title: prop.name.slice(0, 24),
      description: prop.address.slice(0, 72),
    }));
    const listMenu = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '🏠 Select a Property' },
        body: {
          text: chunks.length > 1 ? `Showing chunk ${i + 1}/${chunks.length} of your properties.` : 'Please choose a property:',
        },
        footer: { text: `Chunk ${i + 1}/${chunks.length}` },
        action: {
          button: 'Select',
          sections: [
            {
              title: sectionTitle,
              rows: rows,
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
      console.error('Error sending property chunk list:', err.response?.data || err);
      let fallbackMsg = `🏠 *Select a Property (Chunk ${i + 1}/${chunks.length})*\n`;
      chunk.forEach((p, index) => {
        fallbackMsg += `${index + 1}. ${p.name} - ${p.address}\n`;
      });
      fallbackMsg += '\n[Please pick an item by name or ID]';
      await sendMessage(phoneNumber, fallbackMsg);
    }
  }
}

async function sendUnitSelectionMenu(phoneNumber, units) {
  const chunks = chunkArray(units, 10);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const sectionTitle = `Units ${i + 1}/${chunks.length}`;
    const rows = chunk.map((u) => ({
      id: `chunk${i}_${u._id}`,
      title: u.unitNumber.slice(0, 24),
      description: `Floor: ${u.floor}`.slice(0, 72),
    }));
    const listMenu = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '🚪 Select a Unit' },
        body: {
          text: chunks.length > 1 ? `Showing chunk ${i + 1}/${chunks.length} of your units.` : 'Please choose a unit:',
        },
        footer: { text: `Chunk ${i + 1}/${chunks.length}` },
        action: {
          button: 'Select',
          sections: [
            {
              title: sectionTitle,
              rows: rows,
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
      console.error('Error sending unit chunk list:', err.response?.data || err);
      let fallbackMsg = `🚪 *Select a Unit (Chunk ${i + 1}/${chunks.length})*\n`;
      chunk.forEach((u, index) => {
        fallbackMsg += `${index + 1}. ${u.unitNumber} - Floor: ${u.floor}\n`;
      });
      fallbackMsg += '\n[Please pick an item by name or ID]';
      await sendMessage(phoneNumber, fallbackMsg);
    }
  }
}

async function sendManageSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🛠️ Manage Options' },
      body: { text: '*What would you like to manage?*' },
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
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

async function sendToolsSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🧰 Tools' },
      body: { text: '*Select a tool:*' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'reports', title: '📊 Reports' } },
          { type: 'reply', reply: { id: 'manage', title: '🔧 Maintenance' } },
          { type: 'reply', reply: { id: 'info', title: 'ℹ️ Info' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
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
      header: { type: 'text', text: '🏠 Property Management' },
      body: { text: '*Manage your properties:*' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_property', title: '➕ Add Property' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

async function sendMainMenu(to) {
  const message = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: '🏠 Main Menu' },
      body: { text: 'Please select an option 👇' },
      footer: { text: 'Teraa Assistant' },
      action: {
        button: 'Choose',
        sections: [
          {
            title: 'Properties',
            rows: [
              { id: 'manage_units', title: '🏘️ Manage Units' },
              { id: 'add_unit', title: '➕ Add Unit' }
            ]
          },
          {
            title: 'Tenants',
            rows: [
              { id: 'view_tenants', title: '👥 View Tenants' },
              { id: 'add_tenant', title: '➕ Add Tenant' }
            ]
          },
          {
            title: 'Payments',
            rows: [
              { id: 'record_payment', title: '💰 Record Payment' },
              { id: 'payment_history', title: '📜 Payment History' },
              { id: 'setup_reminders', title: '⏰ Set Reminders' }
            ]
          },
          {
            title: 'Account',
            rows: [
              { id: 'settings', title: '⚙️ Settings' },
              { id: 'upgrade_premium', title: '🚀 Upgrade' },
              { id: 'help_support', title: '❓ Help' }
            ]
          }
        ]
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




async function sendUnitOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '🚪 Unit Management' },
      body: { text: '*Manage your units:*' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_unit', title: '➕ Add Unit' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
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
      body: { text: '*Manage your tenants:*' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_tenant', title: '➕ Add Tenant' } },
        ],
      },
    },
  };
  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}




















// Generic List Sender
async function sendList(to, title, rows) {
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
        button: 'Choose',
        sections: [{ title: 'Options', rows }]
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

// Main Menu

// Units Menu
async function sendUnitsMenu(to) {
  const rows = [
    { id: 'view_units', title: '📋 View Units' },
    { id: 'edit_unit', title: '✏️ Edit Unit' },
    { id: 'delete_unit', title: '🗑️ Delete Unit' }
  ];
  await sendList(to, 'Units Menu', rows);
}

// Prompt to Add Unit
async function promptAddUnit(to) {
  const text = 'Please enter the unit details (e.g., 2BHK Apartment at 45 River Street):';
  await axios.post(WHATSAPP_API_URL, { messaging_product: 'whatsapp', to, text: { body: text }, type: 'text' }, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// Tenants Menu
async function sendTenantsMenu(to) {
  const rows = [
    { id: 'view_tenants', title: '👥 View Tenants' },
    { id: 'edit_tenant', title: '✏️ Edit Tenant' },
    { id: 'remove_tenant', title: '🗑️ Remove Tenant' }
  ];
  await sendList(to, 'Tenants Menu', rows);
}

// Prompt to Add Tenant
async function promptAddTenant(to) {
  const text = 'Please enter tenant info (Name, Unit, Rent amount, e.g., John Doe, Apt 3A, ₹12000):';
  await axios.post(WHATSAPP_API_URL, { messaging_product: 'whatsapp', to, text: { body: text }, type: 'text' }, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// Prompt to Record Payment
async function promptRecordPayment(to) {
  const text = 'Please enter payment details (Tenant, Unit, Amount, Date, e.g., John Doe, Apt 3A, ₹12000, 2025-06-01):';
  await axios.post(WHATSAPP_API_URL, { messaging_product: 'whatsapp', to, text: { body: text }, type: 'text' }, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// Payment History
async function sendPaymentHistory(to) {
  const rows = [
    { id: 'history_1', title: '🗓️ Last 5 Payments' }
  ];
  await sendList(to, 'Payment History', rows);
}

// Reminders Menu
async function sendRemindersMenu(to) {
  const rows = [
    { id: 'view_reminders', title: '⏰ View Reminders' },
    { id: 'add_reminder', title: '➕ Add Reminder' }
  ];
  await sendList(to, 'Reminders', rows);
}

// Settings Menu
async function sendSettingsMenu(to) {
  const rows = [
    { id: 'profile', title: '👤 Profile' },
    { id: 'notifications', title: '🔔 Notifications' },
    { id: 'language', title: '🌐 Language' }
  ];
  await sendList(to, 'Settings', rows);
}



module.exports = {
  sendPropertySelectionMenu,
  sendUnitSelectionMenu,
  sendManageSubmenu,
  sendToolsSubmenu,
  sendPropertyOptions,
  sendUnitOptions,
  sendMainMenu,
  sendTenantOptions,
  
  sendUnitsMenu,
  promptAddUnit,
  sendTenantsMenu,
  promptAddTenant,
  promptRecordPayment,
  sendPaymentHistory,
  sendRemindersMenu,
  sendSettingsMenu
};
