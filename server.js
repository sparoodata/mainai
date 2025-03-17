// server.js
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config();

// Import models (ensure these files exist and export your Mongoose models)
const User = require('./models/User');
const Property = require('./models/Property');
const Unit = require('./models/Unit');
const Tenant = require('./models/Tenant');

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

// ================= WhatsApp Cloud Business API Config =================
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// ================= GROQ API Config =================
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_API_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY,
].filter(Boolean);

if (GROQ_API_KEYS.length === 0) {
  console.error('No GROQ_API_KEY found in environment variables.');
  process.exit(1);
}

function getRandomGroqApiKey() {
  return GROQ_API_KEYS[Math.floor(Math.random() * GROQ_API_KEYS.length)];
}

// ================= Helper: Normalize Phone Number =================
function normalizePhoneNumber(number) {
  if (!number) return number;
  number = number.trim();
  // If number does not start with '+' assume it is an Indian number and prepend +91
  if (number[0] !== '+') {
    return '+' + number;
  }
  return number;
}

// ================= Database Connection =================
async function connectToMongo() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// ================= Helper: Build Memory Context =================
async function buildMemoryForUser(userId) {
  const userDoc = await User.findById(userId).lean();
  if (!userDoc) return 'No user account found for this ID.\n';

  const properties = await Property.find({ userId }).lean();
  const units = await Unit.find({ userId }).lean();
  const tenants = await Tenant.find({ userId }).lean();

  let memoryText = '=== USER ACCOUNT INFO ===\n';
  memoryText += `• Phone Number: ${userDoc.phoneNumber}\n`;
  memoryText += `• Profile Name: ${userDoc.profileName || 'N/A'}\n`;
  memoryText += `• Subscription: ${userDoc.subscription || 'N/A'}\n`;
  memoryText += `• Verified: ${userDoc.verified ? 'Yes' : 'No'}\n`;
  if (userDoc.verifiedDate) {
    memoryText += `• Verified Date: ${userDoc.verifiedDate}\n`;
  }
  memoryText += '\n';

  memoryText += '=== PROPERTIES ===\n';
  properties.forEach(prop => {
    memoryText += `• "${prop.name}" at ${prop.address}, ${prop.units} unit(s), total $${prop.totalAmount}\n`;
  });
  memoryText += '\n';

  memoryText += '=== UNITS ===\n';
  units.forEach(u => {
    const pName = properties.find(p => String(p._id) === String(u.property))?.name || 'Unknown';
    memoryText += `• Unit "${u.unitNumber}", belongs to "${pName}", rent: $${u.rentAmount}\n`;
  });
  memoryText += '\n';

  memoryText += '=== TENANTS ===\n';
  tenants.forEach(t => {
    const assignedUnit = units.find(u => String(u._id) === String(t.unitAssigned));
    memoryText += `• Tenant "${t.name}", monthly rent: $${t.rent_amount}, assigned to ${assignedUnit?.unitNumber || 'None'}\n`;
  });
  memoryText += '\n';

  if (memoryText.length > 3000) {
    memoryText = memoryText.substring(0, 3000) + '...';
  }
  return memoryText;
}

// ================= Helper: Call GROQ API =================
async function callGroqApi(memoryContext, userMessage) {
  const prompt = `
You are a professional, friendly, and knowledgeable rental management assistant.
You have read and write access to the landlord's data provided below.
If the user's command is to modify data (for example, adding, editing, or removing a property, unit, or tenant),
respond with a JSON object exactly in this format:
{
  "action": "add" | "edit" | "remove",
  "entity": "property" | "unit" | "tenant",
  "data": { /* for add: include all required fields; for edit/remove: include an "id" field */ }
}
If the user's command is not a modification request, respond with a plain text message.
Make sure your reply is formatted for WhatsApp messaging.

Here is the user's data:
--------------------------------------------------
${memoryContext}
--------------------------------------------------

User's command: "${userMessage}"

Provide only the JSON output for modification commands or plain text for general queries.
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

// ================= In-Memory Conversation State =================
// Used to track wizard steps (keyed by WhatsApp sender's normalized phone number)
const conversationStates = {};

// Define wizard steps for property insertion
const wizardSteps = [
  {
    field: "name",
    question: "What is the property name?",
    validate: (input) => input.trim().length > 0 ? true : "Property name cannot be empty."
  },
  {
    field: "address",
    question: "What is the property address?",
    validate: (input) => input.trim().length > 0 ? true : "Property address cannot be empty."
  },
  {
    field: "units",
    question: "How many units does this property have? (enter a positive integer)",
    validate: (input) => {
      const num = parseInt(input, 10);
      return (!isNaN(num) && num > 0) ? true : "Please enter a valid positive integer for units.";
    }
  },
  {
    field: "totalAmount",
    question: "What is the total amount? (enter a positive number)",
    validate: (input) => {
      const num = parseFloat(input);
      return (!isNaN(num) && num > 0) ? true : "Please enter a valid positive number for total amount.";
    }
  }
];

// ================= Process a Chat Message =================
async function processChatMessage(phoneNumber, message) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  try {
    const user = await User.findOne({ phoneNumber: normalizedPhone });
    console.log(normalizedPhone);
    if (!user) {
      return "No user found with that phone number.";
    }
    const memoryContext = await buildMemoryForUser(user._id);
    const apiResponse = await callGroqApi(memoryContext, message);
    let parsedCommand;
    try {
      parsedCommand = JSON.parse(apiResponse);
    } catch (e) {
      // Not a JSON response; assume plain text.
    }
    if (parsedCommand && parsedCommand.action && parsedCommand.entity && parsedCommand.data) {
      // Process modification command.
      let resultMessage = '';
      if (parsedCommand.action === 'add') {
        parsedCommand.data.userId = user._id;
        if (parsedCommand.entity === 'property') {
          await Property.create(parsedCommand.data);
          resultMessage = 'Property added successfully.';
        } else if (parsedCommand.entity === 'unit') {
          await Unit.create(parsedCommand.data);
          resultMessage = 'Unit added successfully.';
        } else if (parsedCommand.entity === 'tenant') {
          await Tenant.create(parsedCommand.data);
          resultMessage = 'Tenant added successfully.';
        } else {
          return 'Invalid entity type for addition.';
        }
      } else {
        return 'Unsupported modification command.';
      }
      return resultMessage;
    } else {
      return apiResponse;
    }
  } catch (error) {
    console.error("Error in processChatMessage:", error);
    return "Something went wrong. Please try again.";
  }
}

// ================= Process Wizard Input (Property Insertion) =================
async function processWizardInput(senderId, messageText) {
  const normalizedSender = normalizePhoneNumber(senderId);
  const state = conversationStates[normalizedSender];
  if (!state || state.mode !== "insertProperty") {
    // If no wizard state, process normally.
    const reply = await processChatMessage(normalizedSender, messageText);
    await sendWhatsAppMessage(normalizedSender, reply);
    return;
  }
  const stepIndex = state.stepIndex;
  const currentStep = wizardSteps[stepIndex];
  const validation = currentStep.validate(messageText);
  if (validation !== true) {
    await sendWhatsAppMessage(normalizedSender, validation);
    return; // Stay on current step if validation fails.
  }
  // Save the answer.
  state.data[currentStep.field] = messageText.trim();
  state.stepIndex++;
  if (state.stepIndex < wizardSteps.length) {
    const nextStep = wizardSteps[state.stepIndex];
    await sendWhatsAppMessage(normalizedSender, nextStep.question);
  } else {
    // All details collected; build the command.
    const { name, address, units, totalAmount } = state.data;
    const commandMessage = `Please add a new property with the following details:
Name: ${name},
Address: ${address},
Units: ${units},
Total Amount: ${totalAmount}`;
    const reply = await processChatMessage(normalizedSender, commandMessage);
    await sendWhatsAppMessage(normalizedSender, reply);
    delete conversationStates[normalizedSender];
  }
}

// ================= WhatsApp API: Send Text Message =================
async function sendWhatsAppMessage(to, messageText) {
  try {
    const url = `https://graph.facebook.com/v15.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const data = {
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: messageText }
    };
    await axios.post(url, data, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WHATSAPP_TOKEN}`
      }
    });
  } catch (error) {
    console.error("Error sending WhatsApp message:", error.response ? error.response.data : error.message);
  }
}

// ================= WhatsApp API: Send Interactive Message =================
async function sendWhatsAppInteractiveMessage(to) {
  try {
    const url = `https://graph.facebook.com/v15.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const data = {
      messaging_product: "whatsapp",
      to: to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Please choose an option:" },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "insert_new_property",
                title: "Insert New Property"
              }
            },
            {
              type: "reply",
              reply: {
                id: "other_query",
                title: "Other Query"
              }
            }
          ]
        }
      }
    };
    await axios.post(url, data, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WHATSAPP_TOKEN}`
      }
    });
  } catch (error) {
    console.error("Error sending interactive message:", error.response ? error.response.data : error.message);
  }
}

// ================= WhatsApp Webhook Endpoints =================

// Verification endpoint for WhatsApp Cloud API
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token) {
    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// Webhook endpoint to receive incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object) {
    // Process each entry (can be batched)
    body.entry.forEach(async (entry) => {
      const changes = entry.changes;
      if (changes && changes.length > 0) {
        const value = changes[0].value;
        const messages = value.messages;
        if (messages && messages.length > 0) {
          for (const message of messages) {
            const senderId = message.from; // Sender's WhatsApp number
            let messageText = "";
            // Check for text or interactive button reply.
            if (message.text && message.text.body) {
              messageText = message.text.body;
            } else if (message.interactive && message.interactive.button_reply) {
              messageText = message.interactive.button_reply.id; // Use button ID
            }
            const normalizedSender = normalizePhoneNumber(senderId);
            // If the sender is in a wizard conversation, process wizard input.
            if (conversationStates[normalizedSender] && conversationStates[normalizedSender].mode === "insertProperty") {
              await processWizardInput(senderId, messageText);
            } else {
              // Process interactive button to start wizard.
              if (messageText === "insert_new_property") {
                conversationStates[normalizedSender] = { mode: "insertProperty", stepIndex: 0, data: {} };
                await sendWhatsAppMessage(normalizedSender, wizardSteps[0].question);
              } else if (messageText === "other_query") {
                // For other queries, use the unified chat logic.
                const reply = await processChatMessage(senderId, messageText);
                await sendWhatsAppMessage(normalizedSender, reply);
              } else {
                // Process any other text normally.
                const reply = await processChatMessage(senderId, messageText);
                await sendWhatsAppMessage(normalizedSender, reply);
              }
            }
          }
        }
      }
    });
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// ================= Start the Server =================
async function startServer() {
  await connectToMongo();
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

startServer();
