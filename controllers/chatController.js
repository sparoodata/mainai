// controllers/chatController.js
const axios = require('axios');
const User = require('../models/User');
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Tenant = require('../models/Tenant');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// Collect keys from .env or however you store them
const GROQ_API_KEYS = [
  process.env.GROQ_API_KEY,
  // Add more if you have them
].filter(Boolean);

function getRandomGroqApiKey() {
  return GROQ_API_KEYS[Math.floor(Math.random() * GROQ_API_KEYS.length)];
}

async function buildMemoryForUser(userId) {
  // 1) User doc
  const userDoc = await User.findById(userId).lean();
  if (!userDoc) {
    return 'No user account found for this ID.\n';
  }

  // 2) Related docs
  const properties = await Property.find({ userId }).lean();
  const units = await Unit.find({ userId }).lean();
  const tenants = await Tenant.find({ userId }).lean();

  // 3) Summarize
  let memoryText = '=== USER ACCOUNT INFO ===\n';
  memoryText += `• Phone Number: ${userDoc.phoneNumber}\n`;
  memoryText += `• Profile Name: ${userDoc.profileName || 'N/A'}\n`;
  memoryText += `• Subscription: ${userDoc.subscription || 'N/A'}\n`;
  memoryText += `• Verified: ${userDoc.verified ? 'Yes' : 'No'}\n`;
  if (userDoc.verifiedDate) {
    memoryText += `• Verified Date: ${userDoc.verifiedDate}\n`;
  }
  memoryText += '\n';

  // Properties
  memoryText += '=== PROPERTIES ===\n';
  properties.forEach(prop => {
    memoryText += `• "${prop.name}" at ${prop.address}, ${prop.units} unit(s), total $${prop.totalAmount}\n`;
  });
  memoryText += '\n';

  // Units
  memoryText += '=== UNITS ===\n';
  units.forEach(u => {
    const pName = properties.find(p => String(p._id) === String(u.property))?.name || 'Unknown';
    memoryText += `• Unit "${u.unitNumber}", belongs to "${pName}", rent: $${u.rentAmount}\n`;
  });
  memoryText += '\n';

  // Tenants
  memoryText += '=== TENANTS ===\n';
  tenants.forEach(t => {
    const assignedUnit = units.find(u => String(u._id) === String(t.unitAssigned));
    memoryText += `• Tenant "${t.name}", monthly rent: $${t.rent_amount}, assigned to ${
      assignedUnit?.unitNumber || 'None'
    }\n`;
  });
  memoryText += '\n';

  // Truncate if needed
  if (memoryText.length > 3000) {
    memoryText = memoryText.substring(0, 3000) + '...';
  }

  return memoryText;
}

async function callGroqApi(memoryContext, userMessage) {
  const prompt = `
You are a professional, friendly, and knowledgeable rental management assistant.
(etc.) 
User's question: "${userMessage}"
`;

  for (let i = 0; i < GROQ_API_KEYS.length; i++) {
    const apiKey = getRandomGroqApiKey();
    try {
      const response = await axios.post(
        GROQ_API_URL,
        {
          model: GROQ_MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.5,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );
      return response.data.choices[0].message.content.trim();
    } catch (error) {
      if (error.response && error.response.status === 429) {
        console.warn(`Rate limit for key ${apiKey.substring(0, 8)}... Trying next key.`);
        if (i === GROQ_API_KEYS.length - 1) {
          throw new Error('All GROQ keys exhausted or rate-limited.');
        }
      } else if (error.response && error.response.status === 413) {
        throw new Error('Request too large. Reduce memory or prompt size.');
      } else {
        throw error;
      }
    }
  }

  throw new Error('No GROQ API key succeeded.');
}

module.exports = {
  buildMemoryForUser,
  callGroqApi,
};
