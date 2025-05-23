require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

mongoose.connect(process.env.MONGODB_URI);

const accountSchema = new mongoose.Schema({
  whatsappNumber: String,
  email: String,
  age: Number,
  country: String,
  state: String,
  newsletter: Boolean,
  subscriptionType: { type: String, default: 'free' },
  propertiesLimit: { type: Number, default: 1 },
  tenantsLimit: { type: Number, default: 5 }
});

const Account = mongoose.model('Account', accountSchema);

const whatsappToken = process.env.VERIFY_TOKEN;
const whatsappUrl = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

const sendMessage = async (to, messageData) => {
  await axios.post(whatsappUrl, {
    messaging_product: 'whatsapp',
    to,
    ...messageData
  }, {
    headers: { 'Authorization': `Bearer ${whatsappToken}` }
  });
};

app.post('/webhook', async (req, res) => {
  const message = req.body.entry[0].changes[0].value.messages[0];
  const whatsappNumber = message.from;

  let account = await Account.findOne({ whatsappNumber });

  if (!account) {
    if (message.type === 'interactive' && message.interactive.button_reply.id === 'register') {
      await sendMessage(whatsappNumber, { text: { body: 'Please provide your email ID:' } });
      await Account.create({ whatsappNumber });
    } else {
      await sendMessage(whatsappNumber, {
        interactive: {
          type: 'button',
          body: { text: 'Welcome to the Rental Management Assistant! Manage tenants easily via WhatsApp.' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'register', title: 'Register' } },
              { type: 'reply', reply: { id: 'learn_more', title: 'Learn More' } }
            ]
          }
        }
      });
    }
  } else if (!account.email) {
    account.email = message.text.body;
    await account.save();
    await sendMessage(whatsappNumber, { text: { body: 'Please provide your age:' } });
  } else if (!account.age) {
    account.age = parseInt(message.text.body);
    await account.save();
    await sendMessage(whatsappNumber, { text: { body: 'Please provide your country:' } });
  } else if (!account.country) {
    account.country = message.text.body;
    await account.save();
    await sendMessage(whatsappNumber, { text: { body: 'Please provide your state:' } });
  } else if (!account.state) {
    account.state = message.text.body;
    await account.save();
    await sendMessage(whatsappNumber, {
      interactive: {
        type: 'button',
        body: { text: 'Would you like to receive newsletters via email?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'newsletter_yes', title: 'Yes' } },
            { type: 'reply', reply: { id: 'newsletter_no', title: 'No' } }
          ]
        }
      }
    });
  } else if (message.type === 'interactive' && ['newsletter_yes', 'newsletter_no'].includes(message.interactive.button_reply.id)) {
    account.newsletter = message.interactive.button_reply.id === 'newsletter_yes';
    await account.save();
    await sendMessage(whatsappNumber, { text: { body: `🎉 You are now registered as a free user! You can manage 1 property and 5 tenants. Subscribe to premium for more benefits!` } });
  } else {
    await sendMessage(whatsappNumber, { text: { body: 'You are already registered! How can I assist you today?' } });
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => console.log('Server started'));