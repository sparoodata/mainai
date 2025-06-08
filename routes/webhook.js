// routes/webhook.js
const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const menuHelpers = require('../helpers/menuHelpers');
const { sendMessage } = require('../helpers/whatsapp');
const { askAI }      = require('../helpers/ai');
const { jsonToTableImage } = require('../helpers/tableImage');
const { jsonToTableText }  = require('../helpers/tableText'); 
const { jsonToTablePDF }   = require('../helpers/tablePdf');
const { uploadToWhatsApp, fetchBufferFromUrl } = require('../helpers/pdfHelpers');

const router = express.Router();
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Track conversational context for property/unit flows
const convoStates = {};
const registrationStates = {};
const userResponses = {};

// Interactive Welcome Menu
async function sendWelcomeMenu(to) {
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
router.post('/', async (req, res) => {
  const entry       = req.body.entry?.[0];
  const msg         = entry?.changes?.[0]?.value?.messages?.[0];
  const from        = msg?.from;
  const phone       = `+${from}`;
  const text        = msg?.text?.body?.trim();
  const interactive = msg?.interactive;
  
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

  try {
    const answer = await askAI(aiQuery);           // ① call the AI

    /* ② parse JSON if possible */
    let parsed = null;
    try {
      parsed = JSON.parse(answer);
      // NPIK responses wrap data in { success, data }
      if (
        parsed &&
        typeof parsed === 'object' &&
        'data' in parsed &&
        Array.isArray(parsed.data)
      ) {
        parsed = parsed.data;
      }
    } catch (_) {}

    if (parsed) {
      /* ③ Build QuickChart PDF URL */
      const pdfUrl = jsonToTablePDF(parsed);

      /* ④ Download PDF buffer */
      const pdfBuf = await fetchBufferFromUrl(pdfUrl);

      /* ⑤ Upload PDF to WhatsApp; get media_id */
      const mediaId = await uploadToWhatsApp(
        pdfBuf,
        'report.pdf',
        'application/pdf',
      );

      /* ⑥ Send document message that references the media_id */
      await axios.post(
        WHATSAPP_API_URL,
        {
          messaging_product: 'whatsapp',
          to: from,
          type: 'document',
          document: { id: mediaId, filename: 'report.pdf' },
        },
        {
          headers: {
            Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );
    } else {
      /* fallback – send whatever the AI returned */
      await sendMessage(from, answer);
    }
  } catch (err) {
    console.error('[AI error]', err.response?.data || err.message);
    await sendMessage(
      from,
      '⚠️  The AI service returned an error. Please try again later.'
    );
  }

  return res.sendStatus(200);                       // stop further routing
}
/* ─────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────── */
  
  
  if (!from) return res.sendStatus(200);

  if (interactive?.button_reply) userResponses[phone] = interactive.button_reply.id;
  if (interactive?.list_reply)   userResponses[phone] = interactive.list_reply.id;
  const selected = userResponses[phone];

  const user = await User.findOne({ phoneNumber: phone });

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
        await menuHelpers.promptAddUnit(from);
        break;

      case 'view_tenants':
        await menuHelpers.sendTenantsMenu(from);
        break;

      case 'add_tenant':
        await menuHelpers.promptAddTenant(from);
        break;

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
        await menuHelpers.sendMainMenu(from, user.subscription);
    }

    delete userResponses[phone];
    return res.sendStatus(200);
  }

  // Registration flow
  let reg = registrationStates[phone] || { data: { phoneNumber: phone } };

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
    delete registrationStates[phone];
    await sendRegistrationSuccess(from);
  }

  registrationStates[phone] = reg;
  return res.sendStatus(200);
});

module.exports = { router };
