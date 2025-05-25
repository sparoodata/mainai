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
      header: { type: 'text', text: '🏠 Welcome to Teraa Assistant' },
      body: {
        text: `Hi there! 👋\n\n*Teraa Assistant* is your personal WhatsApp-based **rental management assistant** designed for landlords and property owners.\n\nWith Teraa, you can:\n• Track rent payments\n• Get payment alerts\n• Manage units & tenants\n• Store all data securely\n\nLet’s get started! 🚀`
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
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// Send interactive registration success message
async function sendRegistrationSuccess(to) {
  const message = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '✅ Registration Successful!' },
      body: {
        text: `You're now registered on *Teraa Assistant* 🎉\n\n🔐 *Plan:* Free Subscription\n🏘️ Manage 1 Property with 5 Rental Units\n💡 No rent reminders\n📊 Basic reporting only\n\n✨ *Upgrade to Premium* for:\n✔️ Unlimited Units\n✔️ Rent reminders\n✔️ AI Help & Custom Reports\n✔️ ₹29/month per unit (billed yearly)\n\n🛠️ You can also upgrade anytime from *Settings* in Main Menu.`
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'main_menu', title: '🏠 Main Menu' } },
          { type: 'reply', reply: { id: 'pricing_info', title: '💰 Pricing Info' } }
        ]
      }
    }
  };
  await axios.post(WHATSAPP_API_URL, message, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
}

// Send dynamic interactive list
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

router.get('/', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

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
    if (userResponses[phone] === 'pricing_info') {
      const pricingText = `💳 *Your Current Plan: Free Plan*\n\n✔️ Manage 1 Property\n✔️ Add up to *5 Rental Units*\n📊 Basic reporting\n❌ No rent reminders\n❌ No priority support\n❌ No AI-powered help\n\n━━━━━━━━━━━━━━━━━━━\n✨ *Upgrade to Premium*\n\n🏠 Add unlimited properties & units\n🔔 Get automatic rent reminders\n📊 Advanced reports & payment tracking\n🧠 *AI Help*: Get custom answers, insights & summaries\n📞 Priority WhatsApp support\n\n💰 *Pricing*:\nEach extra unit: ₹29/month\n*Billed annually* → ₹348/unit/year\n\n🧾 Need more than 50 units?\nLet’s talk for custom pricing & enterprise support.\n\n━━━━━━━━━━━━━━━━━━━\n🛠️ You can also upgrade anytime from the *Settings* section in Main Menu.`;
      await sendMessage(from, pricingText);
    } else {
      await menuHelpers.sendMainMenu(from);
    }
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

  if (!user && registrationStates[phone]) {
    const step = registrationStates[phone].step;
    if (step === 'email') {
      const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
      if (!isValid) return await sendMessage(from, '⚠️ Invalid email. Try again.');
      registrationStates[phone].data.email = text;
      registrationStates[phone].step = 'age';
      await sendMessage(from, 'How old are you?');
    } else if (step === 'age') {
      const age = parseInt(text);
      if (isNaN(age) || age < 18 || age > 100) return await sendMessage(from, '⚠️ Enter a valid age (18-100).');
      registrationStates[phone].data.age = age;
      registrationStates[phone].step = 'state';
      await sendList(from, 'State', 'Please select your state 👇', stateRows);
    } else if (step === 'newsletter') {
      const ans = text.toLowerCase();
      if (!['yes', 'no'].includes(ans)) return await sendMessage(from, '⚠️ Reply with *yes* or *no*.');
      registrationStates[phone].data.newsletter = ans === 'yes';
      await new User(registrationStates[phone].data).save();
      delete registrationStates[phone];
      await sendRegistrationSuccess(from);
    }
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

module.exports = { router };
