const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Authorize = require('../models/Authorize');
const Property = require('../models/Property');
const Unit = require('../models/Unit');

module.exports = (groq) => {
  const router = express.Router();

  const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v20.0/110765315459068/messages';
  const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
  const GLITCH_HOST = process.env.GLITCH_HOST;

  const sessions = {};
  let userResponses = {};

  async function shortenUrl(longUrl) {
    try {
      const response = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl));
      return response.data;
    } catch (error) {
      console.error('Error shortening URL:', error);
      return longUrl;
    }
  }

  async function getGroqAIResponse(message, phoneNumber) {
    try {
      const systemPrompt = "You are an AI assistant for a rental management app. Provide helpful responses. Suggest 'Help' for menu options if applicable.";
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
      return 'Sorry, an error occurred. Try "Help" for options.';
    }
  }

  async function sendHelpPrompt(phoneNumber) {
    const helpMessage = `Use 'Help' for menu options:\n\n` +
      `📋 *Help* - See all options\n` +
      `👤 *Account Info* - View account details\n` +
      `🏠 *Manage* - Manage properties, units, tenants\n` +
      `💸 *Transactions* - Handle payments`;
    await sendMessage(phoneNumber, helpMessage);
  }

  router.get('/', (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified');
      return res.status(200).send(challenge);
    }
    res.sendStatus(403);
  });

  router.post('/', async (req, res) => {
    if (req.body.object !== 'whatsapp_business_account') return res.sendStatus(404);

    const entry = req.body.entry[0];
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

      if (!sessions[fromNumber]) sessions[fromNumber] = { action: null };

      if (text) {
        if (text.toLowerCase() === 'help') {
          sessions[fromNumber].action = null;
          const buttonMenu = {
            messaging_product: 'whatsapp',
            to: fromNumber,
            type: 'interactive',
            interactive: {
              type: 'button',
              header: { type: 'text', text: 'Choose an Option' },
              body: { text: 'Please select an option:' },
              footer: { text: 'Powered by your rental app' },
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
          const aiResponse = await getGroqAIResponse(query, phoneNumber);
          await sendMessage(fromNumber, aiResponse);
        } else if (!sessions[fromNumber].action) {
          await sendHelpPrompt(fromNumber);
        }
      }

      if (interactive) {
        const selectedOption = interactive.button_reply.id;
        if (selectedOption === 'account_info') {
          const user = await User.findOne({ phoneNumber });
          const accountInfoMessage = user
            ? `*Account Info*:\n- Phone: ${user.phoneNumber}\n- Verified: ${user.verified ? 'Yes' : 'No'}\n- Name: ${user.profileName || 'N/A'}`
            : 'No account information found.';
          await sendMessage(fromNumber, accountInfoMessage);
        } else if (selectedOption === 'rent_paid') {
          sessions[fromNumber].action = 'rent_paid';
          await sendMessage(fromNumber, 'Please provide the Tenant ID to confirm rent payment.');
        } else if (selectedOption === 'manage') {
          await sendManageSubmenu(fromNumber);
        } else if (selectedOption === 'manage_properties') {
          await sendPropertyOptions(fromNumber);
        } else if (selectedOption === 'manage_units') {
          await sendUnitOptions(fromNumber);
        } else if (selectedOption === 'manage_tenants') {
          await sendTenantOptions(fromNumber);
        } else if (['add_property', 'edit_property', 'remove_property', 'add_unit', 'edit_unit', 'remove_unit', 'add_tenant', 'edit_tenant', 'remove_tenant'].includes(selectedOption)) {
          await sendPropertyLink(fromNumber, selectedOption);
        }
      }

      if (sessions[fromNumber].action === 'rent_paid' && text) {
        const tenantId = text.trim();
        const tenant = await Tenant.findOne({ tenant_id: tenantId });
        if (tenant) {
          tenant.status = 'paid';
          await tenant.save();
          await sendMessage(fromNumber, `Rent payment confirmed for Tenant ID: ${tenantId}.`);
          sessions[fromNumber].action = null;
        } else {
          await sendMessage(fromNumber, `Tenant with ID "${tenantId}" not found.`);
        }
      }
    }

    res.sendStatus(200);
  });

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

  async function waitForUserResponse(phoneNumber, timeout = 30000) {
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
          reject(new Error('Authorization timed out.'));
        }
      }, 500);
    });
  }

  async function sendManageSubmenu(phoneNumber) {
    const buttonMenu = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: 'Manage Options' },
        body: { text: 'Please select an option:' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'manage_properties', title: 'Manage Properties' } },
            { type: 'reply', reply: { id: 'manage_units', title: 'Manage Units' } },
            { type: 'reply', reply: { id: 'manage_tenants', title: 'Manage Tenants' } },
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
        body: { text: 'Please select an option:' },
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
        body: { text: 'Please select an option:' },
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
        body: { text: 'Please select an option:' },
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

  async function sendPropertyLink(phoneNumber, action) {
    try {
      let authorizeRecord = await Authorize.findOne({ phoneNumber: `+${phoneNumber}` });
      if (!authorizeRecord) {
        authorizeRecord = new Authorize({
          phoneNumber: `+${phoneNumber}`,
          used: false,
          action,
          createdAt: new Date(),
        });
      } else {
        authorizeRecord.action = action;
        authorizeRecord.used = false;
      }
      await authorizeRecord.save();

      const longUrl = `${GLITCH_HOST}/authorize/${authorizeRecord._id}`;
      const shortUrl = await shortenUrl(longUrl);
      await sendMessage(phoneNumber, `Proceed: ${shortUrl}`);
    } catch (error) {
      console.error('Error in sendPropertyLink:', error);
      await sendMessage(phoneNumber, 'Failed to generate link. Please try again.');
    }
  }

  return {
    router,
    waitForUserResponse,
    userResponses,
    sendMessage,
  };
};