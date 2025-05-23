require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

mongoose.connect(process.env.MONGODB_URI);

const Account = require('./models/Account');
const Property = require('./models/Property');
const Tenant = require('./models/Tenant');

const whatsappUrl = `https://graph.facebook.com/v20.0/110765315459068/messages`;

async function sendMessage(to, messageData) {
  await axios.post(whatsappUrl, {
    messaging_product: 'whatsapp',
    to,
    ...messageData
  }, {
    headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }
  });
}

const userStates = {};

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.entry[0].changes[0].value.messages[0];
    const phone = message.from;
    const text = message.text?.body;
    const type = message.type;

    let account = await Account.findOne({ whatsappNumber: phone });

    if (!account && type === 'interactive' && message.interactive?.button_reply?.id === 'register') {
      await sendMessage(phone, { text: { body: 'Please provide your email ID:' } });
      userStates[phone] = { step: 'email', data: { whatsappNumber: phone } };
    } else if (!account && type === 'text' && !userStates[phone]) {
      await sendMessage(phone, {
        interactive: {
          type: 'button',
          body: { text: 'Welcome to Rental Assistant! Register to manage tenants.' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'register', title: 'Register' } },
              { type: 'reply', reply: { id: 'learn_more', title: 'Learn More' } }
            ]
          }
        }
      });
    } else if (userStates[phone]) {
      const state = userStates[phone];
      const data = state.data;

      if (state.step === 'email') {
        data.email = text;
        userStates[phone].step = 'age';
        await sendMessage(phone, { text: { body: 'Enter your age:' } });
      } else if (state.step === 'age') {
        data.age = parseInt(text);
        userStates[phone].step = 'country';
        await sendMessage(phone, { text: { body: 'Enter your country:' } });
      } else if (state.step === 'country') {
        data.country = text;
        userStates[phone].step = 'state';
        await sendMessage(phone, { text: { body: 'Enter your state:' } });
      } else if (state.step === 'state') {
        data.state = text;
        userStates[phone].step = 'newsletter';
        await sendMessage(phone, {
          interactive: {
            type: 'button',
            body: { text: 'Would you like to receive newsletters?' },
            action: {
              buttons: [
                { type: 'reply', reply: { id: 'newsletter_yes', title: 'Yes' } },
                { type: 'reply', reply: { id: 'newsletter_no', title: 'No' } }
              ]
            }
          }
        });
      }
    } else if (type === 'interactive' && ['newsletter_yes', 'newsletter_no'].includes(message.interactive.button_reply.id)) {
      const phone = message.from;
      if (userStates[phone]) {
        userStates[phone].data.newsletter = message.interactive.button_reply.id === 'newsletter_yes';
        await Account.create(userStates[phone].data);
        delete userStates[phone];
        await sendMessage(phone, {
          text: {
            body: `✅ Registration successful! You're a free user (1 property, 5 tenants). Upgrade for more!`
          }
        });
      }
    } else if (text?.toLowerCase() === 'upgrade') {
      if (account) {
        account.subscriptionType = 'premium';
        account.propertiesLimit = 10;
        account.tenantsLimit = 100;
        await account.save();
        await sendMessage(phone, { text: { body: '🎉 You are now a premium user!' } });
      }
    } else if (text?.toLowerCase().startsWith('add property')) {
      const name = text.split(':')[1]?.trim();
      if (account) {
        const count = await Property.countDocuments({ ownerPhone: phone });
        if (count >= account.propertiesLimit) {
          await sendMessage(phone, { text: { body: '❌ Property limit reached. Upgrade for more.' } });
        } else {
          await Property.create({ ownerPhone: phone, name, address: 'Not set' });
          await sendMessage(phone, { text: { body: `🏠 Property '${name}' added.` } });
        }
      }
    } else if (text?.toLowerCase() === 'list properties') {
      const props = await Property.find({ ownerPhone: phone });
      const list = props.map(p => `• ${p.name}`).join('\n');
      await sendMessage(phone, { text: { body: `📋 Your Properties:\n${list}` } });
    } else {
      await sendMessage(phone, { text: { body: 'You are already registered. Use commands like: "upgrade", "add property: House1", "list properties"' } });
    }

    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.send('WhatsApp Rental Assistant is running.');
});

app.listen(process.env.PORT || 3000, () => console.log('Server is up'));
