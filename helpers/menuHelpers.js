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

module.exports = {
  sendPropertySelectionMenu,
  sendUnitSelectionMenu,
  sendManageSubmenu,
  sendToolsSubmenu,
  sendPropertyOptions,
  sendUnitOptions,
  sendTenantOptions,
};
