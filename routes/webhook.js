const express = require('express');
const axios = require('axios');
const s3 = require('../config/r2'); // Centralized R2 configuration
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Authorize = require('../models/Authorize');
const Groq = require('groq-sdk');
const redis = require('../config/redis'); // Redis client for session persistence

// Initialize router and constants
const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v20.0/110765315459068/messages';
const GLITCH_HOST = process.env.GLITCH_HOST || 'https://your-glitch-app.glitch.me';

// Session and user response storage with Redis
let sessions = {
  get: async (key) => JSON.parse(await redis.get(`session:${key}`)) || {},
  set: async (key, value) => await redis.set(`session:${key}`, JSON.stringify(value)),
};
let userResponses = {
  get: async (key) => await redis.get(`response:${key}`),
  set: async (key, value) => await redis.set(`response:${key}`, value),
  del: async (key) => await redis.del(`response:${key}`),
};

// Helper Functions

async function sendMessage(phoneNumber, message) {
  try {
    await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'text',
      text: { body: message },
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

async function sendImageMessage(phoneNumber, url, caption) {
  try {
    await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'image',
      image: { link: url, caption },
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error sending WhatsApp image:', error.response?.data || error.message);
    throw error;
  }
}

async function sendPropertyInfo(phoneNumber, property) {
  const propertyDoc = await Property.findById(property._id);
  if (!propertyDoc) {
    await sendMessage(phoneNumber, '⚠️ *Error* \nProperty not found.');
    return;
  }

  let imageUrl = 'https://via.placeholder.com/150';
  if (propertyDoc.images && propertyDoc.images.length > 0) {
    try {
      imageUrl = await s3.getSignedUrlPromise('getObject', {
        Bucket: process.env.R2_BUCKET,
        Key: propertyDoc.images[0],
        Expires: 60,
      });
    } catch (error) {
      console.error('Error generating signed URL for property:', error);
    }
  }

  const caption = `*🏠 Property Details*\n━━━━━━━━━━━━━━━\n*Name*: ${propertyDoc.name}\n*Address*: ${propertyDoc.address}\n*Units*: ${propertyDoc.units}\n*Total Amount*: $${propertyDoc.totalAmount}\n*ID*: ${propertyDoc._id}\n*Created At*: ${propertyDoc.createdAt ? new Date(propertyDoc.createdAt).toLocaleDateString() : 'N/A'}\n━━━━━━━━━━━━━━━`;

  await sendImageMessage(phoneNumber, imageUrl, caption).catch(async (error) => {
    await sendMessage(phoneNumber, `⚠️ *Image Error* \nFailed to load image. Here’s the info:\n${caption}`);
  });
}

async function sendUnitInfo(phoneNumber, unit) {
  const unitDoc = await Unit.findById(unit._id).populate('property');
  if (!unitDoc) {
    await sendMessage(phoneNumber, '⚠️ *Error* \nUnit not found.');
    return;
  }

  let imageUrl = 'https://via.placeholder.com/150';
  if (unitDoc.images && unitDoc.images.length > 0) {
    try {
      imageUrl = await s3.getSignedUrlPromise('getObject', {
        Bucket: process.env.R2_BUCKET,
        Key: unitDoc.images[0],
        Expires: 60,
      });
    } catch (error) {
      console.error('Error generating signed URL for unit:', error);
    }
  }

  const caption = `*🏠 Unit Details*\n━━━━━━━━━━━━━━━\n*Unit Number*: ${unitDoc.unitNumber}\n*Property*: ${unitDoc.property?.name || 'N/A'}\n*Rent Amount*: $${unitDoc.rentAmount}\n*Floor*: ${unitDoc.floor || 'N/A'}\n*Size*: ${unitDoc.size || 'N/A'} sq ft\n*ID*: ${unitDoc._id}\n━━━━━━━━━━━━━━━`;

  await sendImageMessage(phoneNumber, imageUrl, caption).catch(async (error) => {
    await sendMessage(phoneNumber, `⚠️ *Image Error* \nFailed to load image. Here’s the info:\n${caption}`);
  });
}

async function sendTenantInfo(phoneNumber, tenant) {
  const tenantDoc = await Tenant.findById(tenant._id).populate('unitAssigned');
  if (!tenantDoc) {
    await sendMessage(phoneNumber, '⚠️ *Error* \nTenant not found.');
    return;
  }

  let imageUrl = 'https://via.placeholder.com/150';
  if (tenantDoc.images && tenantDoc.images.length > 0) {
    try {
      imageUrl = await s3.getSignedUrlPromise('getObject', {
        Bucket: process.env.R2_BUCKET,
        Key: tenantDoc.images[0],
        Expires: 60,
      });
    } catch (error) {
      console.error('Error generating signed URL for tenant:', error);
    }
  }

  const caption = `*👤 Tenant Details*\n━━━━━━━━━━━━━━━\n*Name*: ${tenantDoc.name}\n*Phone*: ${tenantDoc.phoneNumber}\n*Unit*: ${tenantDoc.unitAssigned?.unitNumber || 'N/A'}\n*Property*: ${tenantDoc.propertyName || 'N/A'}\n*Lease Start*: ${tenantDoc.lease_start ? new Date(tenantDoc.lease_start).toLocaleDateString() : 'N/A'}\n*Deposit*: $${tenantDoc.deposit}\n*Rent Amount*: $${tenantDoc.rent_amount}\n*Tenant ID*: ${tenantDoc.tenant_id}\n*Email*: ${tenantDoc.email || 'N/A'}\n━━━━━━━━━━━━━━━`;

  await sendImageMessage(phoneNumber, imageUrl, caption).catch(async (error) => {
    await sendMessage(phoneNumber, `⚠️ *Image Error* \nFailed to load image. Here’s the info:\n${caption}`);
  });
}

async function generateAIResponse(prompt) {
  try {
    const response = await groq.chat.completions.create({
      model: 'mixtral-8x7b-32768',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
    });
    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error generating AI response:', error);
    return 'Sorry, I couldn’t generate a response at this time.';
  }
}

// Webhook Route
router.post('/', async (req, res) => {
  const { object, entry } = req.body;

  if (object !== 'whatsapp_business_account') {
    return res.sendStatus(404);
  }

  const { changes } = entry[0];
  const { value } = changes[0];

  // Handle contact updates
// Handle contact updates
if (value.contacts) {
  const { wa_id, profile } = value.contacts[0];
  const phoneNumber = `+${wa_id}`;

  try {
    await User.findOneAndUpdate(
      { phoneNumber },
      { profileName: profile.name },
      { new: true, upsert: true }
    );
  } catch (error) {
    console.error(`Error updating user for ${phoneNumber}:`, error);
    return res.sendStatus(500); // Move this inside the catch block
  }
}
  // Handle incoming messages
  if (value.messages) {
    const { from, text, interactive } = value.messages[0];
    const phoneNumber = `+${from}`;

    try {
      const user = await User.findOne({ phoneNumber });
      if (!user) {
        await sendMessage(phoneNumber, '⚠️ *Error* \nYou are not registered. Please sign up first.');
        return res.sendStatus(200);
      }

      let session = await sessions.get(phoneNumber);
      const userResponse = await userResponses.get(phoneNumber);

      if (interactive && interactive.button_reply) {
        const { id } = interactive.button_reply;

        if (id === 'YES_CONFIRM') {
          const [action, docId] = userResponse.split(':');
          let authorizeUrl;

          if (action === 'editTenant') {
            const tenant = await Tenant.findOne({ tenant_id: docId, userId: user._id });
            authorizeUrl = `${GLITCH_HOST}/edittenant/${user._id}?tenantId=${tenant._id}`;
          } else {
            authorizeUrl = `${GLITCH_HOST}/${action}/${user._id}`;
          }

          const authorizeRecord = await new Authorize({
            phoneNumber,
            action: action === 'editTenant' ? 'edittenant' : action,
          }).save();

          await sendMessage(phoneNumber, `🔗 Here’s the link to ${action.replace('Tenant', ' Tenant')}:\n${authorizeUrl.replace(user._id, authorizeRecord._id)}`);
          await userResponses.del(phoneNumber);
          session.step = 0;
        } else if (id === 'NO_CANCEL') {
          await sendMessage(phoneNumber, '❌ Action cancelled.');
          await userResponses.del(phoneNumber);
          session.step = 0;
        }
      } else if (text && text.body) {
        const message = text.body.trim().toLowerCase();

        if (message === 'hi' || message === 'hello') {
          await sendMessage(phoneNumber, '👋 Hello! How can I assist you today?\n- *Properties*: List your properties\n- *Units*: List your units\n- *Tenants*: List your tenants\n- *Add/Edit/Delete*: Manage your data');
          session.step = 0;
        } else if (message === 'properties') {
          const properties = await Property.find({ userId: user._id });
          if (properties.length === 0) {
            await sendMessage(phoneNumber, '🏠 You have no properties yet.');
          } else {
            for (const property of properties) {
              await sendPropertyInfo(phoneNumber, property);
            }
          }
          session.step = 0;
        } else if (message === 'units') {
          const units = await Unit.find({ userId: user._id });
          if (units.length === 0) {
            await sendMessage(phoneNumber, '🏠 You have no units yet.');
          } else {
            for (const unit of units) {
              await sendUnitInfo(phoneNumber, unit);
            }
          }
          session.step = 0;
        } else if (message === 'tenants') {
          const tenants = await Tenant.find({ userId: user._id });
          if (tenants.length === 0) {
            await sendMessage(phoneNumber, '👤 You have no tenants yet.');
          } else {
            for (const tenant of tenants) {
              await sendTenantInfo(phoneNumber, tenant);
            }
          }
          session.step = 0;
        } else if (['addproperty', 'addunit', 'addtenant', 'editproperty', 'editunit', 'edittenant', 'deleteproperty', 'deleteunit'].includes(message)) {
          const action = message;
          const authorizeRecord = await new Authorize({
            phoneNumber,
            action: action === 'edittenant' ? 'edittenant' : action,
          }).save();

          await sendMessage(phoneNumber, `🔗 Here’s the link to ${action.replace('tenant', ' tenant')}:\n${GLITCH_HOST}/${action}/${authorizeRecord._id}`);
          session.step = 0;
        } else if (message.startsWith('edit tenant ')) {
          const tenantId = message.split('edit tenant ')[1];
          const tenant = await Tenant.findOne({ tenant_id: tenantId, userId: user._id });
          if (!tenant) {
            await sendMessage(phoneNumber, `⚠️ *Error* \nTenant with ID ${tenantId} not found.`);
          } else {
            await userResponses.set(phoneNumber, `editTenant:${tenantId}`);
            await sendMessage(phoneNumber, `Are you sure you want to edit tenant ${tenantId}?\n\n*Reply with:*\n- YES_CONFIRM: Confirm\n- NO_CANCEL: Cancel`, {
              reply_markup: {
                keyboard: [['YES_CONFIRM'], ['NO_CANCEL']],
                one_time_keyboard: true,
              },
            });
            session.step = 1;
          }
        } else {
          const aiResponse = await generateAIResponse(`You are a property management assistant. A user asked: "${message}". Provide a helpful response related to property management.`);
          await sendMessage(phoneNumber, aiResponse);
          session.step = 0;
        }
      }

      await sessions.set(phoneNumber, session);
    } catch (error) {
      console.error('Error processing webhook:', error);
      await sendMessage(phoneNumber, '⚠️ *Error* \nSomething went wrong. Please try again later.');
    }
  }

  res.sendStatus(200);
});

// Webhook verification
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

module.exports = { router, sendMessage };