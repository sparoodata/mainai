const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const AWS = require('aws-sdk');
const multer = require('multer');
require('dotenv').config();
const Property = require('./models/Property');
const Unit = require('./models/Unit');
const Tenant = require('./models/Tenant');
const Image = require('./models/Image');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Configure multer for multiple file uploads (up to 3 images)
const upload = multer({ storage: multer.memoryStorage() }).array('images', 3);

// Cloudflare R2 configuration
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  Bucket: process.env.R2_BUCKET,
  region: 'auto',
  signatureVersion: 'v4',
});

// WhatsApp Business Cloud API configuration
const WHATSAPP_API_URL = 'https://graph.facebook.com/v19.0'; // Latest version as of March 2025
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Groq API configuration
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const GROQ_API_KEYS = [
  process.env.GROQ_API_KEY1,
  process.env.GROQ_API_KEY2,
  process.env.GROQ_API_KEY3,
  process.env.GROQ_API_KEY4,
  process.env.GROQ_API_KEY5,
].filter(key => key);

if (GROQ_API_KEYS.length === 0) {
  console.error('No valid Groq API keys found in .env');
  process.exit(1);
}

function getRandomGroqApiKey() {
  const randomIndex = Math.floor(Math.random() * GROQ_API_KEYS.length);
  return GROQ_API_KEYS[randomIndex];
}

// MongoDB Message Schema
const messageSchema = new mongoose.Schema({
  role: String,
  content: String,
  sessionId: String,
  timestamp: { type: Date, default: Date.now },
});
const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);

// MongoDB connection
async function connectToMongo() {
  try {
    await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB');
    await seedInitialData();
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    process.exit(1);
  }
}

// Seed initial data
async function seedInitialData() {
  const propertyCount = await Property.countDocuments();
  if (propertyCount === 0) {
    const property = await Property.create({
      name: 'Sunset Apartments',
      units: 10,
      address: '123 Main St',
      totalAmount: 15000,
      userId: new mongoose.Types.ObjectId(),
      createdAt: new Date(),
    });
    await Unit.create({
      unitNumber: '101',
      property: property._id,
      rentAmount: 1500,
      createdAt: new Date(),
    });
    await Unit.create({
      unitNumber: '122',
      property: property._id,
      rentAmount: 4747,
      createdAt: new Date(),
    });
    await Tenant.create({
      name: 'Ramulu',
      unitAssigned: (await Unit.findOne({ unitNumber: '122' }))._id,
      propertyName: 'Ambabai Nilayam',
      rent_amount: 5500,
      createdAt: new Date(),
    });
    console.log('Seeded initial property, units, and tenant');
  }
}

// Conversation state
const conversationState = new Map();

// Store message in MongoDB
async function storeMessage(sessionId, role, content) {
  try {
    await Message.create({ role, content, sessionId });
    console.log('Message stored successfully');
  } catch (error) {
    console.error('MongoDB store error:', error.message);
    throw error;
  }
}

// Get memory context
async function getMemory(sessionId) {
  try {
    const messages = await Message.find({ sessionId }).sort({ timestamp: -1 }).limit(10);
    const properties = await Property.find();
    const units = await Unit.find();
    const tenants = await Tenant.find();
    const tenantLines = await Promise.all(tenants.map(async t => {
      const unit = t.unitAssigned ? await Unit.findById(t.unitAssigned) : null;
      return `${t.name} - Unit: ${unit ? unit.unitNumber : 'None'} - Property: ${t.propertyName} - Rent: $${t.rent_amount} - Created: ${t.createdAt}`;
    }));
    const memory = `
      Messages (last 10):\n${messages.reverse().map(m => `${m.role}: ${m.content}`).join('\n')}
      Properties:\n${properties.map(p => `${p.name}: ${p.address}, ${p.units} units, $${p.totalAmount}, Created: ${p.createdAt}`).join('\n')}
      Units:\n${units.map(u => `${u.unitNumber} (Property: ${u.property}): $${u.rentAmount}, Created: ${u.createdAt}`).join('\n')}
      Tenants:\n${tenantLines.join('\n')}
    `;
    return memory.length > 1000 ? memory.substring(0, 1000) + '...' : memory;
  } catch (error) {
    console.error('MongoDB get memory error:', error.message);
    return '';
  }
}

// Shorten URL using TinyURL
async function shortenUrl(longUrl) {
  try {
    const response = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl));
    return response.data;
  } catch (error) {
    console.error('Error shortening URL:', error.response ? error.response.data : error);
    return longUrl;
  }
}

// Send WhatsApp message (text or interactive)
async function sendWhatsAppMessage(to, messageBody, interactive = null) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: interactive ? 'interactive' : 'text',
  };

  if (interactive) {
    payload.interactive = interactive;
  } else {
    payload.text = { body: messageBody };
  }

  try {
    const response = await axios.post(
      `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('WhatsApp message sent:', response.data);
    return response.data;
  } catch (error) {
    console.error('WhatsApp API error:', error.response ? error.response.data : error.message);
    throw error;
  }
}

// Intent recognition using Groq
async function getIntentResponse(memoryContext, message, sessionId) {
  const prompt = `
    You are a landlord assistant. Use the following data from memory to respond:
    ${memoryContext}
    User input: "${message}"
    Task:
    1. If a query (e.g., "list tenants"), return a clear response.
    2. If a command (e.g., "create tenant", "add property"), return JSON: {"intent": "add_tenant", "step": "unit", "response": "Which unit would you like to assign the new tenant to?"}
    3. If unclear, ask for clarification.
    4. For greetings, respond conversationally.
  `;

  for (let i = 0; i < GROQ_API_KEYS.length; i++) {
    const apiKey = getRandomGroqApiKey();
    try {
      console.log(`Using Groq API key: ${apiKey.substring(0, 5)}... for request`);
      const groqResponse = await axios.post(
        GROQ_API_URL,
        {
          model: GROQ_MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 500,
          temperature: 0.5,
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );
      const responseText = groqResponse.data.choices[0].message.content.trim();
      try {
        const jsonResponse = JSON.parse(responseText);
        if (jsonResponse.intent && jsonResponse.step) {
          conversationState.set(sessionId, { entity: jsonResponse.intent.split('_')[1], step: jsonResponse.step, data: {} });
          return jsonResponse.response;
        }
        return responseText;
      } catch {
        return responseText; // Fallback to plain text if not JSON
      }
    } catch (error) {
      if (error.response && error.response.status === 429) {
        console.warn(`Rate limit hit with key ${apiKey.substring(0, 5)}... Trying next key.`);
        if (i === GROQ_API_KEYS.length - 1) throw new Error('All API keys hit rate limit (429).');
        continue;
      } else if (error.response && error.response.status === 413) {
        throw new Error('Payload too large. Memory context exceeds API limit.');
      }
      throw error;
    }
  }
}

// Webhook for WhatsApp incoming messages
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry) {
      for (const change of entry.changes) {
        if (change.field === 'messages' && change.value.messages) {
          const message = change.value.messages[0];
          const phoneNumber = message.from;
          const sessionId = `whatsapp_${phoneNumber}`;
          const text = message.type === 'text' ? message.text.body : message.button ? message.button.text : '';

          await processChatMessage({ message: text, phoneNumber, sessionId });
        }
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Process chat message
async function processChatMessage({ message, phoneNumber, sessionId }) {
  try {
    await storeMessage(sessionId, 'user', message);
    let reply;

    if (conversationState.has(sessionId)) {
      const state = conversationState.get(sessionId);
      console.log(`Session ${sessionId} - Entity: ${state.entity}, Step: ${state.step}, Data:`, state.data);

      switch (state.entity) {
        case 'tenant':
          reply = await handleTenantSteps(state, message, sessionId, phoneNumber);
          break;
        case 'property':
          reply = await handlePropertySteps(state, message, sessionId, phoneNumber);
          break;
        case 'unit':
          reply = await handleUnitSteps(state, message, sessionId, phoneNumber);
          break;
        default:
          reply = 'Something went wrong. Please try again.';
          conversationState.delete(sessionId);
      }
      if (!reply.includes('Please type "done"')) {
        conversationState.set(sessionId, state);
      }
    } else {
      const memoryContext = await getMemory(sessionId);
      reply = await getIntentResponse(memoryContext, message, sessionId);
    }

    // Send reply via WhatsApp
    if (reply.includes('Which unit')) {
      const units = await Unit.find().limit(3); // Limit to 3 for button constraints
      const interactive = {
        type: 'button',
        body: { text: 'Which unit would you like to assign the new tenant to?' },
        action: {
          buttons: units.map(unit => ({
            type: 'reply',
            reply: { id: unit.unitNumber, title: `Unit ${unit.unitNumber}` },
          })),
        },
      };
      await sendWhatsAppMessage(phoneNumber, null, interactive);
    } else if (reply.includes('The unit’s rent')) {
      const interactive = {
        type: 'button',
        body: { text: reply },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
            { type: 'reply', reply: { id: 'no', title: 'No' } },
          ],
        },
      };
      await sendWhatsAppMessage(phoneNumber, null, interactive);
    } else {
      await sendWhatsAppMessage(phoneNumber, reply);
    }

    await storeMessage(sessionId, 'assistant', reply);
  } catch (error) {
    console.error('Chat processing error:', error.message);
    const errorReply = 'Something went wrong! Please try again.';
    await sendWhatsAppMessage(phoneNumber, errorReply);
    await storeMessage(sessionId, 'assistant', errorReply);
    conversationState.delete(sessionId);
  }
}

// Handle tenant steps
async function handleTenantSteps(state, message, sessionId, phoneNumber) {
  switch (state.step) {
    case 'unit':
      const unit = await Unit.findOne({ unitNumber: message });
      if (!unit) return 'Unit not found. Please provide a valid unit number.';
      state.data.unitNumber = message;
      state.data.unitAssigned = unit._id;
      state.data.propertyName = (await Property.findById(unit.property)).name;
      state.data.rent_amount = unit.rentAmount;
      state.step = 'name';
      return 'What’s the tenant’s name?';
    case 'name':
      state.data.name = message;
      state.step = 'phone';
      return 'What’s the tenant’s phone number?';
    case 'phone':
      state.data.phoneNumber = message;
      state.step = 'deposit';
      return 'What’s the deposit amount?';
    case 'deposit':
      state.data.deposit = parseFloat(message);
      state.step = 'rent';
      return `The unit’s rent is $${state.data.rent_amount}. Use this amount?`;
    case 'rent':
      state.data.rent_amount = message.toLowerCase() === 'yes' ? state.data.rent_amount : message.toLowerCase() === 'no' ? null : parseFloat(message);
      if (state.data.rent_amount === null) {
        state.step = 'rent'; // Stay on rent step if "No"
        return 'Please provide the monthly rent amount.';
      }
      state.step = 'tenant_id';
      return 'Please provide a unique tenant ID.';
    case 'tenant_id':
      state.data.tenant_id = message;
      state.step = 'image';
      const uploadUrl = `https://lacy-snapdragon-saguaro.glitch.me/upload?sessionId=${sessionId}&entity=tenant&id=${state.data.tenant_id}`;
      const shortUrl = await shortenUrl(uploadUrl);
      return `Please upload up to 3 images for the tenant here: ${shortUrl}. Once uploaded, type "done" to continue.`;
    case 'image':
      if (message.toLowerCase() === 'done') {
        state.data.createdAt = new Date();
        await Tenant.create(state.data);
        conversationState.delete(sessionId);
        return `Tenant ${state.data.name} added successfully!`;
      }
      return 'Please type "done" after uploading the images.';
    default:
      conversationState.delete(sessionId);
      return 'Something went wrong. Please try again.';
  }
}

// Handle property steps
async function handlePropertySteps(state, message, sessionId, phoneNumber) {
  switch (state.step) {
    case 'name':
      state.data.name = message;
      state.step = 'units';
      return 'How many units does the property have?';
    case 'units':
      state.data.units = parseInt(message);
      state.step = 'address';
      return 'What’s the property’s address?';
    case 'address':
      state.data.address = message;
      state.step = 'totalAmount';
      return 'What’s the total monthly rent amount for the property?';
    case 'totalAmount':
      state.data.totalAmount = parseFloat(message);
      state.step = 'image';
      const uploadUrl = `https://lacy-snapdragon-saguaro.glitch.me/upload?sessionId=${sessionId}&entity=property&id=${state.data.name}`;
      const shortUrl = await shortenUrl(uploadUrl);
      return `Please upload up to 3 images for the property here: ${shortUrl}. Once uploaded, type "done" to continue.`;
    case 'image':
      if (message.toLowerCase() === 'done') {
        state.data.createdAt = new Date();
        await Property.create(state.data);
        conversationState.delete(sessionId);
        return `Property ${state.data.name} added successfully!`;
      }
      return 'Please type "done" after uploading the images.';
    default:
      conversationState.delete(sessionId);
      return 'Something went wrong. Please try again.';
  }
}

// Handle unit steps
async function handleUnitSteps(state, message, sessionId, phoneNumber) {
  switch (state.step) {
    case 'property':
      const property = await Property.findOne({ name: message });
      if (!property) return 'Property not found. Please provide a valid property name.';
      state.data.property = property._id;
      state.step = 'unitNumber';
      return 'What’s the unit number?';
    case 'unitNumber':
      const existingUnit = await Unit.findOne({ unitNumber: message, property: state.data.property });
      if (existingUnit) return 'Unit number already exists for this property. Please provide a unique unit number.';
      state.data.unitNumber = message;
      state.step = 'rentAmount';
      return 'What’s the rent amount for this unit?';
    case 'rentAmount':
      state.data.rentAmount = parseFloat(message);
      state.step = 'image';
      const uploadUrl = `https://lacy-snapdragon-saguaro.glitch.me/upload?sessionId=${sessionId}&entity=unit&id=${state.data.unitNumber}`;
      const shortUrl = await shortenUrl(uploadUrl);
      return `Please upload up to 3 images for the unit here: ${shortUrl}. Once uploaded, type "done" to continue.`;
    case 'image':
      if (message.toLowerCase() === 'done') {
        state.data.createdAt = new Date();
        await Unit.create(state.data);
        conversationState.delete(sessionId);
        return `Unit ${state.data.unitNumber} added successfully!`;
      }
      return 'Please type "done" after uploading the images.';
    default:
      conversationState.delete(sessionId);
      return 'Something went wrong. Please try again.';
  }
}

// Image upload page
app.get('/upload', (req, res) => {
  const { sessionId, entity, id } = req.query;
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Upload ${entity} Images</title>
    </head>
    <body>
      <h1>Upload ${entity} Images (Max 3)</h1>
      <form action="/upload-image" method="post" enctype="multipart/form-data">
        <input type="hidden" name="sessionId" value="${sessionId}">
        <input type="hidden" name="entity" value="${entity}">
        <input type="hidden" name="id" value="${id}">
        <input type="file" name="images" accept="image/*" multiple required>
        <button type="submit">Upload</button>
      </form>
      <p>Note: You can upload up to 3 images. Select multiple files by holding Ctrl (Windows) or Cmd (Mac).</p>
    </body>
    </html>
  `);
});

// Handle image upload
app.post('/upload-image', upload, async (req, res) => {
  const { sessionId, entity, id } = req.body;
  const files = req.files;

  try {
    if (!files || files.length === 0) throw new Error('No images uploaded.');
    if (files.length > 3) throw new Error('Maximum of 3 images allowed.');

    const imageIds = [];
    for (const file of files) {
      const key = `images/${entity}s/${id}/${Date.now()}-${file.originalname}`;
      const uploadParams = {
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      };

      const uploadResult = await s3.upload(uploadParams).promise();
      const imageUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
      const image = await Image.create({ imageUrl, imageName: file.originalname });
      imageIds.push(image._id);
    }

    const state = conversationState.get(sessionId);
    console.log(`Upload - Session: ${sessionId}, Entity: ${entity}, ID: ${id}, State:`, state);

    if (state) {
      const idField = entity === 'tenant' ? 'tenant_id' : entity === 'property' ? 'name' : 'unitNumber';
      if (state.data[idField] === id) {
        state.data.images = state.data.images || [];
        state.data.images.push(...imageIds.slice(0, 3 - state.data.images.length));
        conversationState.set(sessionId, state);
      } else {
        console.warn(`ID mismatch: Expected ${state.data[idField]}, Got ${id}`);
      }
    } else {
      console.warn(`No state found for session ${sessionId}. Images uploaded but not linked to entity.`);
    }

    await storeMessage(sessionId, 'assistant', `${files.length} image(s) uploaded successfully!`);
    res.send(`${files.length} image(s) uploaded successfully! Return to the chat and type "done" to continue.`);
  } catch (error) {
    console.error('Error uploading images:', error.message, error.stack);
    res.status(500).send(`Error uploading images: ${error.message}`);
  }
});

// Start server
async function startServer() {
  await connectToMongo();
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

startServer();