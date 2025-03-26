// routes/groq.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();

// Import models
const User = require('../models/User');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Tenant = require('../models/Tenant');

// GROQ API
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const GROQ_API_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY,
].filter(Boolean);

function getRandomGroqApiKey() {
  return GROQ_API_KEYS[Math.floor(Math.random() * GROQ_API_KEYS.length)];
}

async function buildMemoryForUser(userId) {
  const userDoc = await User.findById(userId).lean();
  if (!userDoc) return 'No user account found.';

  const [properties, units, tenants] = await Promise.all([
    Property.find({ userId }).lean(),
    Unit.find({ userId }).lean(),
    Tenant.find({ userId }).lean(),
  ]);

  let memoryText = `User: ${userDoc.profileName || userDoc.phoneNumber}\n`;

  properties.forEach(prop => {
    memoryText += `Property: ${prop.name} at ${prop.address}, ${prop.units} units, $${prop.totalAmount}\n`;
  });

  units.forEach(u => {
    const property = properties.find(p => String(p._id) === String(u.property));
    memoryText += `Unit: ${u.unitNumber}, Property: ${property?.name}, Rent: $${u.rentAmount}\n`;
  });

  tenants.forEach(t => {
    const unit = units.find(u => String(u._id) === String(t.unitAssigned));
    memoryText += `Tenant: ${t.name}, Rent: $${t.rent_amount}, Unit: ${unit?.unitNumber}\n`;
  });

  return memoryText.slice(0, 3000);
}

async function callGroqApi(memoryContext, userMessage) {
  const prompt = `Use landlord data:\n${memoryContext}\nQuestion: ${userMessage}`;

  const response = await axios.post(GROQ_API_URL, {
    model: GROQ_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 300,
    temperature: 0.5,
  }, {
    headers: {
      Authorization: `Bearer ${getRandomGroqApiKey()}`,
      'Content-Type': 'application/json',
    },
  });

  return response.data.choices[0].message.content.trim();
}

router.post('/', async (req, res) => {
  const { phoneNumber, message } = req.body;

  if (!message.startsWith('/')) {
    return res.status(400).json({ error: 'Message must start with a backward slash (/)'});
  }

  const actualMessage = message.slice(1).trim();

  try {
    const user = await User.findOne({ phoneNumber });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const memoryContext = await buildMemoryForUser(user._id);
    const reply = await callGroqApi(memoryContext, actualMessage);

    res.json({ reply });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error occurred.' });
  }
});

module.exports = router;
