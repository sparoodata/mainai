require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Validate environment variables
const requiredEnvVars = ['MONGODB_URI', 'PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'VERIFY_TOKEN'];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`Error: Environment variable ${varName} is missing`);
    process.exit(1);
  }
});

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('Connected to MongoDB'))
.catch((err) => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

mongoose.set('strictQuery', true);

// WhatsApp Cloud API Configuration
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const sendWhatsAppMessage = async (to, messageBody) => {
  try {
    await axios.post(
      `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        ...messageBody
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data);
  }
};

// Models
const User = require('./models/User');
const Property = require('./models/Property');
const Tenant = require('./models/Tenant');
const Unit = require('./models/Unit');

// Webhook for incoming messages
app.post('/webhook', async (req, res) => {
  console.log('Incoming webhook payload:', JSON.stringify(req.body, null, 2));

  // Validate basic payload structure
  if (!req.body || !req.body.entry || !Array.isArray(req.body.entry) || req.body.entry.length === 0) {
    console.error('Invalid or missing "entry" in webhook payload');
    return res.sendStatus(400);
  }

  const entry = req.body.entry[0];
  if (!entry.changes || !Array.isArray(entry.changes) || entry.changes.length === 0) {
    console.error('Invalid or missing "changes" in webhook entry');
    return res.sendStatus(400);
  }

  const change = entry.changes[0];
  // Check if this is a message event (has "messages") or a status update (has "statuses")
  if (!change.value || !change.value.messages || !Array.isArray(change.value.messages) || change.value.messages.length === 0) {
    // If it’s a status update or something else, just acknowledge it silently
    return res.sendStatus(200);
  }

  const message = change.value.messages[0];
  let incomingMsg;
  if (message?.text?.body) {
    incomingMsg = message.text.body.toLowerCase().trim();
  } else if (message?.interactive?.button_reply?.id) {
    incomingMsg = message.interactive.button_reply.id.toLowerCase().trim();
  }

  const fromNumber = change.value.contacts?.[0]?.wa_id;

  if (!incomingMsg || !fromNumber) {
    console.error('Missing message body or sender number');
    return res.sendStatus(200);
  }
  console.log(fromNumber);
  let user = await User.findOne({ phoneNumber: fromNumber });

  if (!user) {
    await sendWhatsAppMessage(fromNumber, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { 
          text: 'Welcome to MyTenants! It seems you\'re not registered yet.\n\nOur app helps landlords manage properties, units, and tenants easily.' 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'onboard', title: 'Onboard' } }
          ]
        }
      }
    });
  } else if (incomingMsg === 'help') {
    await sendWhatsAppMessage(fromNumber, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'MyTenants Menu:' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'account', title: 'Account Info' } },
            { type: 'reply', reply: { id: 'manage', title: 'Manage' } },
            { type: 'reply', reply: { id: 'tools', title: 'Tools' } }
          ]
        }
      }
    });
  } else if (incomingMsg === 'account') {
    await sendWhatsAppMessage(fromNumber, {
      type: 'text',
      text: {
        body: `Account Information:\nPhone: ${user.phoneNumber}\nName: ${user.profileName || 'Not set'}\nVerified: ${user.verified ? 'Yes' : 'No'}\nSubscription: ${user.subscription}\nRegistered: ${user.registrationDate.toDateString()}${user.verifiedDate ? `\nVerified Date: ${user.verifiedDate.toDateString()}` : ''}`
      }
    });
  } else if (incomingMsg === 'manage') {
    await sendWhatsAppMessage(fromNumber, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Manage:' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'properties', title: 'Properties' } },
            { type: 'reply', reply: { id: 'units', title: 'Units' } },
            { type: 'reply', reply: { id: 'tenants', title: 'Tenants' } }
          ]
        }
      }
    });
  } else if (incomingMsg === 'properties') {
    await sendWhatsAppMessage(fromNumber, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Property Management:' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'add_property', title: 'Add Property' } },
            { type: 'reply', reply: { id: 'edit_property', title: 'Edit Property' } },
            { type: 'reply', reply: { id: 'delete_property', title: 'Delete Property' } }
          ]
        }
      }
    });
  } else if (incomingMsg === 'onboard') {
    try {
      const newUser = new User({
        phoneNumber: fromNumber,
        profileName: 'Landlord',
        verified: false,
        subscription: 'Free'
      });
      await newUser.save();
      await sendWhatsAppMessage(fromNumber, {
        type: 'text',
        text: { body: 'Registration successful! Type "Help" to see options.' }
      });
    } catch (error) {
      await sendWhatsAppMessage(fromNumber, {
        type: 'text',
        text: { body: 'Error during registration. Please try again.' }
      });
    }
  } else {
    await sendWhatsAppMessage(fromNumber, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Welcome to MyTenants!\nYour rental management assistant.' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'help', title: 'Help' } },
            { type: 'reply', reply: { id: 'ask_ai', title: 'Ask AI' } }
          ]
        }
      }
    });
  }

  res.sendStatus(200);
});

// Webhook verification
app.get('/webhook', (req, res) => {
  const verifyToken = process.env.VERIFY_TOKEN;

  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === verifyToken
  ) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});