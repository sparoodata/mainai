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
    console.log(`Sending message to ${to}:`, JSON.stringify(messageBody, null, 2));
    const response = await axios.post(
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
    console.log('Message sent successfully:', response.data);
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
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
  if (!change.value || !change.value.messages || !Array.isArray(change.value.messages) || change.value.messages.length === 0) {
    console.log('Received status update or non-message event, ignoring');
    return res.sendStatus(200);
  }

  const message = change.value.messages[0];
  let incomingMsg;
  if (message?.text?.body) {
    incomingMsg = message.text.body.toLowerCase().trim();
    console.log('Received text message:', incomingMsg);
  } else if (message?.interactive?.button_reply?.id) {
    incomingMsg = message.interactive.button_reply.id.toLowerCase().trim();
    console.log('Received button reply:', incomingMsg);
  }

  let fromNumber = change.value.contacts?.[0]?.wa_id;
  if (!fromNumber) {
    console.error('Missing sender number');
    return res.sendStatus(200);
  }

  if (!fromNumber.startsWith('+')) {
    fromNumber = `+${fromNumber}`;
  }
  console.log('Sender number:', fromNumber);

  if (!incomingMsg) {
    console.error('Missing message body');
    return res.sendStatus(200);
  }

  let user = await User.findOne({ phoneNumber: fromNumber });
  console.log('User lookup result:', user ? 'Found' : 'Not found');

  if (!user) {
    await sendWhatsAppMessage(fromNumber, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { 
          text: '*Welcome to MyTenants!*\nYou’re not registered yet. Simplify property management with our WhatsApp solution.' 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'onboard', title: 'Get Started' } }
          ]
        }
      }
    });
  } else if (incomingMsg === 'help') {
    await sendWhatsAppMessage(fromNumber, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { 
          text: '*MyTenants Dashboard*\nHow may I assist you today?' 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'account', title: 'My Account' } },
            { type: 'reply', reply: { id: 'portfolio', title: 'Portfolio' } },
            { type: 'reply', reply: { id: 'reports', title: 'Reports' } }
          ]
        }
      }
    });
  } else if (incomingMsg === 'account') {
    await sendWhatsAppMessage(fromNumber, {
      type: 'text',
      text: {
        body: `*Account Details*\nPhone: ${user.phoneNumber}\nName: ${user.profileName || 'Not set'}\nVerified: ${user.verified ? 'Yes ✅' : 'No'}\nSubscription: ${user.subscription}\nRegistered: ${user.registrationDate.toDateString()}${user.verifiedDate ? `\nVerified On: ${user.verifiedDate.toDateString()}` : ''}`
      }
    });
  } else if (incomingMsg === 'portfolio') {
    await sendWhatsAppMessage(fromNumber, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { 
          text: '*Property Portfolio*\nManage your rental assets:' 
        },
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
        body: { 
          text: '*Property Management*\nSelect an action:' 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'add_property', title: 'Add Property' } },
            { type: 'reply', reply: { id: 'edit_property', title: 'Edit Property' } },
            { type: 'reply', reply: { id: 'delete_property', title: 'Delete Property' } }
          ]
        }
      }
    });
  } else if (incomingMsg === 'units') {
    await sendWhatsAppMessage(fromNumber, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { 
          text: '*Unit Management*\nSelect an action:' 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'add_unit', title: 'Add Unit' } },
            { type: 'reply', reply: { id: 'edit_unit', title: 'Edit Unit' } },
            { type: 'reply', reply: { id: 'delete_unit', title: 'Delete Unit' } }
          ]
        }
      }
    });
  } else if (incomingMsg === 'tenants') {
    await sendWhatsAppMessage(fromNumber, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { 
          text: '*Tenant Management*\nSelect an action:' 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'add_tenant', title: 'Add Tenant' } },
            { type: 'reply', reply: { id: 'edit_tenant', title: 'Edit Tenant' } },
            { type: 'reply', reply: { id: 'delete_tenant', title: 'Delete Tenant' } }
          ]
        }
      }
    });
  } else if (incomingMsg === 'reports') {
    await sendWhatsAppMessage(fromNumber, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { 
          text: '*Financial Reports*\nChoose a report:' 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'rent_due', title: 'Rent Due' } },
            { type: 'reply', reply: { id: 'occupancy', title: 'Occupancy' } },
            { type: 'reply', reply: { id: 'maintenance', title: 'Maintenance' } }
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
        text: { 
          body: '*Registration Successful!*\nWelcome aboard! Type *Help* to explore your dashboard.' 
        }
      });
    } catch (error) {
      await sendWhatsAppMessage(fromNumber, {
        type: 'text',
        text: { 
          body: '*Registration Failed*\nSomething went wrong. Please try again.' 
        }
      });
    }
  } else {
    await sendWhatsAppMessage(fromNumber, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { 
          text: '*MyTenants*\nYour rental management assistant.\nHow can I assist you today?'
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'help', title: 'Dashboard' } },
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
    console.log('Webhook verified successfully');
    return res.send(req.query['hub.challenge']);
  }
  console.error('Webhook verification failed');
  res.sendStatus(403);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});