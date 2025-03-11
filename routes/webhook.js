const express = require('express');
const axios = require('axios');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Image = require('../models/Image');
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const router = express.Router();

const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
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
    const response = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [
        { role: 'system', content: "You are an AI agent for a rental management app. Guide the user through adding properties, units, or tenants if they choose those actions." },
        { role: 'user', content: message },
      ],
      max_tokens: 200,
      temperature: 0.7,
    });
    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error with Groq AI:', error);
    return '⚠️ *Sorry*, I encountered an error. Please try again.';
  }
}

async function sendMessage(phoneNumber, message) {
  try {
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
  } catch (err) {
    console.error('Error sending WhatsApp message:', err.response ? err.response.data : err);
  }
}

router.get('/', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post('/', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    if (value.contacts) {
      const contact = value.contacts[0];
      const phoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile.name;

      const user = await User.findOne({ phoneNumber });
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

      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null, step: 0, data: {} };
      }

      if (text) {
        const session = sessions[fromNumber];

        // Handle Add Property
        if (session.action === 'add_property') {
          switch (session.step) {
            case 0:
              await sendMessage(fromNumber, '🏠 *Add Property*\nPlease provide the property name:');
              session.step = 1;
              break;
            case 1:
              session.data.property_name = text;
              await sendMessage(fromNumber, '📍 Please provide the address:');
              session.step = 2;
              break;
            case 2:
              session.data.address = text;
              await sendMessage(fromNumber, '🔢 How many units does this property have?');
              session.step = 3;
              break;
            case 3:
              session.data.units = parseInt(text);
              await sendMessage(fromNumber, '💰 What is the total amount (in dollars)?');
              session.step = 4;
              break;
            case 4:
              session.data.totalAmount = parseFloat(text);
              await sendMessage(fromNumber, '📸 Would you like to upload an image? Reply "yes" or "no".');
              session.step = 5;
              break;
            case 5:
              if (text.toLowerCase() === 'yes') {
                const sessionId = Date.now().toString();
                sessions[fromNumber].sessionId = sessionId;
                const longUrl = `${GLITCH_HOST}/upload-image/${sessionId}`;
                const shortUrl = await shortenUrl(longUrl);
                await sendMessage(fromNumber, `📸 *Upload Image*\nClick this link to upload an image: *${shortUrl}*`);
                session.step = 6;
              } else {
                await saveProperty(fromNumber, session.data, null);
                session.action = null;
                session.step = 0;
                session.data = {};
              }
              break;
            case 6:
              if (session.data.imageUrl) {
                await saveProperty(fromNumber, session.data, session.data.imageUrl);
                session.action = null;
                session.step = 0;
                session.data = {};
              }
              break;
          }
        }

        // Handle Add Unit
        else if (session.action === 'add_unit') {
          switch (session.step) {
            case 0:
              const properties = await Property.find({ userId: (await User.findOne({ phoneNumber }))._id });
              if (!properties.length) {
                await sendMessage(fromNumber, 'ℹ️ *No Properties Found*\nAdd a property first.');
                session.action = null;
                break;
              }
              let propertyList = '*🏠 Select a Property*\nReply with the number:\n';
              properties.forEach((p, i) => propertyList += `${i + 1}. ${p.name}\n`);
              await sendMessage(fromNumber, propertyList);
              session.data.properties = properties;
              session.step = 1;
              break;
            case 1:
              const propertyIndex = parseInt(text) - 1;
              if (propertyIndex >= 0 && propertyIndex < session.data.properties.length) {
                session.data.property = session.data.properties[propertyIndex]._id;
                await sendMessage(fromNumber, '🚪 Please provide the unit number:');
                session.step = 2;
              } else {
                await sendMessage(fromNumber, '⚠️ *Invalid Selection*\nPlease reply with a valid number.');
              }
              break;
            case 2:
              session.data.unit_number = text;
              await sendMessage(fromNumber, '💰 What is the rent amount (in dollars)?');
              session.step = 3;
              break;
            case 3:
              session.data.rent_amount = parseFloat(text);
              await sendMessage(fromNumber, '📏 What is the size (in sq ft)?');
              session.step = 4;
              break;
            case 4:
              session.data.size = parseFloat(text);
              await sendMessage(fromNumber, '📸 Would you like to upload an image? Reply "yes" or "no".');
              session.step = 5;
              break;
            case 5:
              if (text.toLowerCase() === 'yes') {
                const sessionId = Date.now().toString();
                sessions[fromNumber].sessionId = sessionId;
                const longUrl = `${GLITCH_HOST}/upload-image/${sessionId}`;
                const shortUrl = await shortenUrl(longUrl);
                await sendMessage(fromNumber, `📸 *Upload Image*\nClick this link to upload an image: *${shortUrl}*`);
                session.step = 6;
              } else {
                await saveUnit(fromNumber, session.data, null);
                session.action = null;
                session.step = 0;
                session.data = {};
              }
              break;
            case 6:
              if (session.data.imageUrl) {
                await saveUnit(fromNumber, session.data, session.data.imageUrl);
                session.action = null;
                session.step = 0;
                session.data = {};
              }
              break;
          }
        }

        // Handle Add Tenant
        else if (session.action === 'add_tenant') {
          switch (session.step) {
            case 0:
              await sendMessage(fromNumber, '👤 *Add Tenant*\nPlease provide the tenant’s name:');
              session.step = 1;
              break;
            case 1:
              session.data.name = text;
              const properties = await Property.find({ userId: (await User.findOne({ phoneNumber }))._id });
              if (!properties.length) {
                await sendMessage(fromNumber, 'ℹ️ *No Properties Found*\nAdd a property first.');
                session.action = null;
                break;
              }
              let propertyList = '*🏠 Select a Property*\nReply with the number:\n';
              properties.forEach((p, i) => propertyList += `${i + 1}. ${p.name}\n`);
              await sendMessage(fromNumber, propertyList);
              session.data.properties = properties;
              session.step = 2;
              break;
            case 2:
              const propertyIndex = parseInt(text) - 1;
              if (propertyIndex >= 0 && propertyIndex < session.data.properties.length) {
                session.data.propertyName = session.data.properties[propertyIndex].name;
                const units = await Unit.find({ property: session.data.properties[propertyIndex]._id });
                if (!units.length) {
                  await sendMessage(fromNumber, 'ℹ️ *No Units Found*\nAdd a unit first.');
                  session.action = null;
                  break;
                }
                let unitList = '*🚪 Select a Unit*\nReply with the number:\n';
                units.forEach((u, i) => unitList += `${i + 1}. ${u.unitNumber}\n`);
                await sendMessage(fromNumber, unitList);
                session.data.units = units;
                session.step = 3;
              } else {
                await sendMessage(fromNumber, '⚠️ *Invalid Selection*\nPlease reply with a valid number.');
              }
              break;
            case 3:
              const unitIndex = parseInt(text) - 1;
              if (unitIndex >= 0 && unitIndex < session.data.units.length) {
                session.data.unitAssigned = session.data.units[unitIndex]._id;
                await sendMessage(fromNumber, '📅 What is the lease start date (YYYY-MM-DD)?');
                session.step = 4;
              } else {
                await sendMessage(fromNumber, '⚠️ *Invalid Selection*\nPlease reply with a valid number.');
              }
              break;
            case 4:
              session.data.lease_start = text;
              await sendMessage(fromNumber, '💰 What is the deposit amount (in dollars)?');
              session.step = 5;
              break;
            case 5:
              session.data.deposit = parseFloat(text);
              await sendMessage(fromNumber, '💰 What is the rent amount (in dollars)?');
              session.step = 6;
              break;
            case 6:
              session.data.rent_amount = parseFloat(text);
              await sendMessage(fromNumber, '📸 Would you like to upload a photo? Reply "yes" or "no".');
              session.step = 7;
              break;
            case 7:
              if (text.toLowerCase() === 'yes') {
                const sessionId = Date.now().toString();
                sessions[fromNumber].sessionId = sessionId;
                const longUrl = `${GLITCH_HOST}/upload-image/${sessionId}`;
                const shortUrl = await shortenUrl(longUrl);
                await sendMessage(fromNumber, `📸 *Upload Photo*\nClick this link to upload a photo: *${shortUrl}*`);
                session.step = 8;
              } else {
                await saveTenant(fromNumber, session.data, null);
                session.action = null;
                session.step = 0;
                session.data = {};
              }
              break;
            case 8:
              if (session.data.imageUrl) {
                await saveTenant(fromNumber, session.data, session.data.imageUrl);
                session.action = null;
                session.step = 0;
                session.data = {};
              }
              break;
          }
        }

        // Default handling
        else if (text.toLowerCase() === 'help') {
          await sendMessage(fromNumber, '🏠 *Rental Management*\nUse commands like: "Add Property", "Add Unit", "Add Tenant"');
        } else if (text.toLowerCase() === 'add property') {
          session.action = 'add_property';
          session.step = 0;
          await sendMessage(fromNumber, '🏠 *Add Property*\nPlease provide the property name:');
        } else if (text.toLowerCase() === 'add unit') {
          session.action = 'add_unit';
          session.step = 0;
          const properties = await Property.find({ userId: (await User.findOne({ phoneNumber }))._id });
          if (!properties.length) {
            await sendMessage(fromNumber, 'ℹ️ *No Properties Found*\nAdd a property first.');
            session.action = null;
          } else {
            let propertyList = '*🏠 Select a Property*\nReply with the number:\n';
            properties.forEach((p, i) => propertyList += `${i + 1}. ${p.name}\n`);
            await sendMessage(fromNumber, propertyList);
            session.data.properties = properties;
            session.step = 1;
          }
        } else if (text.toLowerCase() === 'add tenant') {
          session.action = 'add_tenant';
          session.step = 0;
          await sendMessage(fromNumber, '👤 *Add Tenant*\nPlease provide the tenant’s name:');
        } else {
          const aiResponse = await getGroqAIResponse(text, fromNumber);
          await sendMessage(fromNumber, aiResponse);
        }
      }
    }
  }
  res.sendStatus(200);
});

// Save Property
async function saveProperty(phoneNumber, data, imageUrl) {
  const user = await User.findOne({ phoneNumber });
  const property = new Property({
    name: data.property_name,
    address: data.address,
    units: data.units,
    totalAmount: data.totalAmount,
    userId: user._id,
  });
  await property.save();

  if (imageUrl) {
    const image = new Image({ propertyId: property._id, imageUrl });
    await image.save();
    property.images.push(image._id);
    await property.save();
  }

  await sendMessage(phoneNumber, `✅ *Property Added*\n"${data.property_name}" has been added successfully!`);
}

// Save Unit
async function saveUnit(phoneNumber, data, imageUrl) {
  const user = await User.findOne({ phoneNumber });
  const unit = new Unit({
    property: data.property,
    unitNumber: data.unit_number,
    rentAmount: data.rent_amount,
    size: data.size,
    userId: user._id,
  });
  await unit.save();

  if (imageUrl) {
    const image = new Image({ unitId: unit._id, imageUrl });
    await image.save();
    unit.images.push(image._id);
    await unit.save();
  }

  await sendMessage(phoneNumber, `✅ *Unit Added*\n"${data.unit_number}" has been added successfully!`);
}

// Save Tenant
async function saveTenant(phoneNumber, data, imageUrl) {
  const user = await User.findOne({ phoneNumber });
  const tenant = new Tenant({
    name: data.name,
    phoneNumber: user.phoneNumber,
    userId: user._id,
    propertyName: data.propertyName,
    unitAssigned: data.unitAssigned,
    lease_start: new Date(data.lease_start),
    deposit: data.deposit,
    rent_amount: data.rent_amount,
    tenant_id: 'T' + Math.floor(1000 + Math.random() * 9000) + String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  });

  if (imageUrl) tenant.photo = imageUrl;
  await tenant.save();

  await sendMessage(phoneNumber, `✅ *Tenant Added*\n"${data.name}" has been added successfully!`);
}

module.exports = { router, sendMessage };