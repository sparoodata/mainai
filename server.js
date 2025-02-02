const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// Middleware for parsing JSON and URL-encoded bodies
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Environment Variables (set these in Glitch or a .env file)
// VERIFY_TOKEN: Your webhook verify token
// WHATSAPP_ACCESS_TOKEN: Your WhatsApp Business Cloud API access token
// PHONE_NUMBER_ID: Your WhatsApp Business Cloud API phone number ID
// GROQ_API_KEY: Your AI endpoint API key

// The fixed system prompt with MongoDB schemas and instructions
const systemPrompt = `You are a rental management assistant for the database. Your main purpose is to help a landlord manage properties, units, tenants, images, and authorizations.

---
### DATABASE SCHEMAS
\`\`\`js
// authorizeSchema
const mongoose = require("mongoose");
const authorizeSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true },
    status: { type: String, required: true, default: "Sent" }
});
const Authorize = mongoose.model("Authorize", authorizeSchema);
module.exports = Authorize;

// imageSchema
const imageSchema = new mongoose.Schema({
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: "Property" },
    imageUrl: String,
    imageName: String,
    uploadedAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model("Image", imageSchema);

// propertySchema
const propertySchema = new mongoose.Schema({
    name: { type: String, required: true },
    units: { type: Number, required: true },
    address: { type: String, required: true },
    totalAmount: { type: Number, required: true },
    images: [{ type: mongoose.Schema.Types.ObjectId, ref: "Image" }],
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
});
module.exports = mongoose.model("Property", propertySchema);

// tenantSchema
const tenantSchema = new mongoose.Schema({
    name: { type: String, required: true },
    phoneNumber: { type: String, required: true },
    propertyName: { type: String, required: true },
    unitAssigned: { type: mongoose.Schema.Types.ObjectId, ref: "Unit", required: true },
    lease_start: { type: Date, required: true },
    deposit: { type: Number, required: true },
    rent_amount: { type: Number, required: true },
    tenant_id: { type: String, required: true },
    photo: { type: String },
    idProof: { type: String },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
});
module.exports = mongoose.model("Tenant", tenantSchema);

// unitSchema
const unitSchema = new mongoose.Schema({
    property: { type: mongoose.Schema.Types.ObjectId, ref: "Property", required: true },
    unitNumber: { type: String, required: true },
    rentAmount: { type: Number, required: true },
    floor: { type: String },
    size: { type: Number },
    images: [{ type: mongoose.Schema.Types.ObjectId, ref: "Image" }],
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
});
module.exports = mongoose.model("Unit", unitSchema);
\`\`\`

---
### INSTRUCTIONS

1. **Role & Behavior**
   - You will receive queries and tasks from the user (landlord). They may request data retrieval, updates, inserts, etc.
   - If a **MongoDB query** is needed, respond **only** with the exact query between the lines \`QUERY:\` and \`ENDQUERY\` and **nothing else** (no additional text or explanation).
   - If **no database query** is needed, provide **no output** at all.

2. **MongoDB Query Format**
   - Your query must be in this form:
     \`\`\`
     QUERY:
     db.<collection>.<operation>( ... )
     ENDQUERY
     \`\`\`
   - Do **not** include any extra text, comments, or explanations outside this code block.
`;

// WhatsApp webhook verification endpoint
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// WhatsApp webhook endpoint for processing incoming messages
app.post('/webhook', async (req, res) => {
  try {
    // WhatsApp Business Cloud API sends updates in a specific format
    if (req.body.object) {
      const entries = req.body.entry;
      for (let entry of entries) {
        const changes = entry.changes;
        for (let change of changes) {
          const value = change.value;
          if (value.messages) {
            // Process each received message
            for (let message of value.messages) {
              const from = message.from; // Sender's WhatsApp number
              let incomingMessage = "";
              if (message.text && message.text.body) {
                incomingMessage = message.text.body;
              }
              console.log(`Received message from ${from}: ${incomingMessage}`);

              // Build the payload for the AI endpoint
              const requestBody = {
                model: "llama-3.3-70b-versatile",
                messages: [
                  {
                    role: "system",
                    content: systemPrompt
                  },
                  {
                    role: "user",
                    content: incomingMessage
                  }
                ]
              };

              // Call the AI endpoint
              const aiResponse = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                requestBody,
                {
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
                  }
                }
              );

              // Extract the AI response content
              const aiContent = aiResponse.data.choices[0].message.content;
              console.log(aiContent);

              // Use regex to extract the MongoDB query between QUERY: and ENDQUERY
              const regex = /QUERY:\s*([\s\S]*?)\s*ENDQUERY/;
              const match = aiContent.match(regex);
              let queryResult = "";
              if (match && match[1]) {
                queryResult = match[1].trim();
              } else {
                queryResult = "No MongoDB query generated.";
              }

              // Build payload for sending a message via WhatsApp Cloud API
              const whatsappPayload = {
                messaging_product: "whatsapp",
                to: from,
                text: {
                  body: queryResult
                }
              };

              // Send the reply using the WhatsApp Business Cloud API
              await axios.post(
                `https://graph.facebook.com/v17.0/${process.env.PHONE_NUMBER_ID}/messages`,
                whatsappPayload,
                {
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
                  }
                }
              );
            }
          }
        }
      }
      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error("Error processing webhook:", error.response ? error.response.data : error);
    res.sendStatus(500);
  }
});

// A simple route to verify the server is running
app.get('/', (req, res) => {
  res.send('WhatsApp Business Cloud API Integration is running.');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
