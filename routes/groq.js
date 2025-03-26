// routes/groq.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();

// Import your Mongoose models
const User = require('../models/User');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Tenant = require('../models/Tenant');

// GROQ API
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// Collect all your keys (repeat if you have multiple)
const GROQ_API_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY
].filter(Boolean);

function getRandomGroqApiKey() {
  return GROQ_API_KEYS[Math.floor(Math.random() * GROQ_API_KEYS.length)];
}

/**
 * Build memory text from all user data
 */
async function buildMemoryForUser(userId) {
  const userDoc = await User.findById(userId).lean();
  if (!userDoc) return 'No user account found.';

  // We'll gather all associated user data
  const [properties, units, tenants] = await Promise.all([
    Property.find({ userId }).lean(),
    Unit.find({ userId }).lean(),
    Tenant.find({ userId }).lean()
  ]);

  let memoryText = `User: ${userDoc.profileName || userDoc.phoneNumber}\n`;

  // Show properties
  properties.forEach((prop) => {
    memoryText += `Property: ${prop.name} at ${prop.address}, ${prop.units} units, $${prop.totalAmount}\n`;
  });

  // Show units
  units.forEach((u) => {
    const property = properties.find((p) => String(p._id) === String(u.property));
    memoryText += `Unit: ${u.unitNumber}, Property: ${property?.name}, Rent: $${u.rentAmount}\n`;
  });

  // Show tenants
  tenants.forEach((t) => {
    const unit = units.find((u) => String(u._id) === String(t.unitAssigned));
    memoryText += `Tenant: ${t.name}, Rent: $${t.rent_amount}, Unit: ${unit?.unitNumber}\n`;
  });

  // Truncate if needed
  return memoryText.slice(0, 3000);
}

/**
 * Call the Groq API using one of the keys
 */
async function callGroqApi(memoryContext, userMessage) {
  const prompt = `Use landlord data:\n${memoryContext}\nQuestion: ${userMessage}`;

  // Attempt each key if rate-limited
  for (let i = 0; i < GROQ_API_KEYS.length; i++) {
    const apiKey = getRandomGroqApiKey();
    try {
      const response = await axios.post(
        GROQ_API_URL,
        {
          model: GROQ_MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.5
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data.choices[0].message.content.trim();
    } catch (error) {
      if (error.response && error.response.status === 429) {
        console.warn(`Rate limit for key ${apiKey} – trying next key...`);
        if (i === GROQ_API_KEYS.length - 1) {
          throw new Error('All GROQ keys exhausted or rate-limited.');
        }
      } else {
        throw error;
      }
    }
  }

  throw new Error('No GROQ API key succeeded.');
}

/**
 * POST /groq  (The main route)
 */
router.post('/', async (req, res) => {
  // Safely extract from body
  const { phoneNumber, message } = req.body || {};

  // Validate
  if (!phoneNumber || !message) {
    return res.status(400).json({
      error: 'phoneNumber and message are required in JSON body.'
    });
  }

  // Must start with '/'
  if (!message.startsWith('/')) {
    return res.status(400).json({
      error: 'Message must start with a backward slash (/)'
    });
  }

  // Strip the slash
  const actualMessage = message.slice(1).trim();

  try {
    // Check user
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Build memory + call Groq
    const memoryContext = await buildMemoryForUser(user._id);
    const reply = await callGroqApi(memoryContext, actualMessage);

    // Return the AI's answer
    return res.json({ reply });
  } catch (error) {
    console.error('Error calling Groq:', error);
    return res.status(500).json({ error: 'Server error occurred.' });
  }
});

module.exports = router;
