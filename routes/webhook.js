const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const menuHelpers = require('../helpers/menuHelpers');
const { sendMessage } = require('../helpers/whatsapp');

const router = express.Router();
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const registrationStates = {};
const userResponses = {};

// Send interactive welcome menu
async function sendWelcomeMenu(to) {
  const welcome = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '👋 Welcome to Teraa Assistant' },
      body: {
        text: `Teraa Assistant helps rental property owners manage properties, units, and tenants directly via WhatsApp. What would you like to do?`
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'start_registration', title: '📝 Register' } },
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

// Interactive lists
async function sendList(to, type, title, rows) {
  const message = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: title },
      action: {
        button: `Select ${type}`,
        sections: [{ title: `${type}s`, rows }]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, message, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

const languageRows = [
  { id: 'lang_english', title: 'English' },
  { id: 'lang_hindi', title: 'Hindi' },
  { id: 'lang_telugu', title: 'Telugu' },
  { id: 'lang_tamil', title: 'Tamil' },
  { id: 'lang_malayalam', title: 'Malayalam' },
  { id: 'lang_kannada', title: 'Kannada' },
];

const stateRows = [
  { id: 'state_Telangana', title: 'Telangana' },
  { id: 'state_AndhraPradesh', title: 'Andhra Pradesh' },
  { id: 'state_Karnataka', title: 'Karnataka' },
  { id: 'state_Tamilnadu', title: 'Tamil Nadu' },
  { id: 'state_Kerala', title: 'Kerala' },
  { id: 'state_Delhi', title: 'Delhi' },
  { id: 'state_Maharashtra', title: 'Maharashtra' },
];

// Webhook GET verification
router.get('/', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Webhook POST handler
router.post('/', async (req, res) => {
  const entry = req.body?.entry?.[0];
  const message = entry?.changes?.[0]?.value?.messages?.[0];
  const from = message?.from;
  const phone = `+${from}`;
  const text = message?.text?.body?.trim();
  const interactive = message?.interactive;

  if (!from) return res.sendStatus(200);

  if (interactive?.button_reply) userResponses[phone] = interactive.button_reply.id;
  if (interactive?.list_reply) userResponses[phone] = interactive.list_reply.id;

  const user = await User.findOne({ phoneNumber: phone });

  if ((text?.toLowerCase() === 'help' || text?.toLowerCase() === 'start') && !user) {
    await sendWelcomeMenu(from);
    return res.sendStatus(200);
  } else if (user) {
    await menuHelpers.sendMainMenu(from);
    return res.sendStatus(200);
  }

  const selected = userResponses[phone];
  const reg = registrationStates[phone] || { data: { phoneNumber: phone } };

  if (!user && selected) {
    if (selected === 'start_registration') {
      reg.step = 'language';
      await sendList(from, 'Language', 'Please select your preferred language 👇', languageRows);
    } else if (selected.startsWith('lang_') && reg.step === 'language') {
      reg.data.language = selected.replace('lang_', '');
      reg.step = 'country';
      await sendList(from, 'Country', 'Please select your country 👇', [{ id: 'country_India', title: 'India' }]);
    } else if (selected.startsWith('country_') && reg.step === 'country') {
      reg.data.country = selected.replace('country_', '');
      reg.step = 'email';
      await sendMessage(from, 'Please enter your email address:');
    } else if (selected.startsWith('state_') && reg.step === 'state') {
      reg.data.state = selected.replace('state_', '');
      reg.step = 'newsletter';
      await sendMessage(from, 'Would you like to receive newsletters? (yes/no)');
    }
    registrationStates[phone] = reg;
    delete userResponses[phone];
    return res.sendStatus(200);
  }

  // Handle input responses
  if (!user && registrationStates[phone]) {
    const step = reg.step;
    if (step === 'email') {
      const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
      if (!isValid) return await sendMessage(from, '⚠️ Invalid email. Try again.');
      reg.data.email = text;
      reg.step = 'age';
      await sendMessage(from, 'How old are you?');
    } else if (step === 'age') {
      const age = parseInt(text);
      if (isNaN(age) || age < 18 || age > 100) return await sendMessage(from, '⚠️ Enter a valid age (18-100).');
      reg.data.age = age;
      reg.step = 'state';
      await sendList(from, 'State', 'Please select your state 👇', stateRows);
    } else if (step === 'newsletter') {
      const ans = text.toLowerCase();
      if (!['yes', 'no'].includes(ans)) return await sendMessage(from, '⚠️ Reply with *yes* or *no*.');
      reg.data.newsletter = ans === 'yes';
      await new User(reg.data).save();
      delete registrationStates[phone];
      await sendMessage(from, '✅ Registered successfully! Type *menu* to begin.');
    }
    registrationStates[phone] = reg;
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

module.exports = { router };
