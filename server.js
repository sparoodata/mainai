const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));
// Middleware
app.use(bodyParser.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('Could not connect to MongoDB', err));

// Routes
app.post('/query', async (req, res) => {
  const { message } = req.body;

  try {
    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "You are a rental management assistant for the database. Your main purpose is to help a landlord manage properties, units, tenants, images, and authorizations.\n\n---\n### DATABASE SCHEMAS\n```js\n// authorizeSchema\nconst mongoose = require(\"mongoose\");\nconst authorizeSchema = new mongoose.Schema({\n    phoneNumber: { type: String, required: true },\n    status: { type: String, required: true, default: \"Sent\" }\n});\nconst Authorize = mongoose.model(\"Authorize\", authorizeSchema);\nmodule.exports = Authorize;\n\n// imageSchema\nconst imageSchema = new mongoose.Schema({\n    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: \"Property\" },\n    imageUrl: String,\n    imageName: String,\n    uploadedAt: { type: Date, default: Date.now }\n});\nmodule.exports = mongoose.model(\"Image\", imageSchema);\n\n// propertySchema\nconst propertySchema = new mongoose.Schema({\n    name: { type: String, required: true },\n    units: { type: Number, required: true },\n    address: { type: String, required: true },\n    totalAmount: { type: Number, required: true },\n    images: [{ type: mongoose.Schema.Types.ObjectId, ref: \"Image\" }],\n    userId: { type: mongoose.Schema.Types.ObjectId, ref: \"User\", required: true }\n});\nmodule.exports = mongoose.model(\"Property\", propertySchema);\n\n// tenantSchema\nconst tenantSchema = new mongoose.Schema({\n    name: { type: String, required: true },\n    phoneNumber: { type: String, required: true },\n    propertyName: { type: String, required: true },\n    unitAssigned: { type: mongoose.Schema.Types.ObjectId, ref: \"Unit\", required: true },\n    lease_start: { type: Date, required: true },\n    deposit: { type: Number, required: true },\n    rent_amount: { type: Number, required: true },\n    tenant_id: { type: String, required: true },\n    photo: { type: String },\n    idProof: { type: String },\n    userId: { type: mongoose.Schema.Types.ObjectId, ref: \"User\", required: true }\n});\nmodule.exports = mongoose.model(\"Tenant\", tenantSchema);\n\n// unitSchema\nconst unitSchema = new mongoose.Schema({\n    property: { type: mongoose.Schema.Types.ObjectId, ref: \"Property\", required: true },\n    unitNumber: { type: String, required: true },\n    rentAmount: { type: Number, required: true },\n    floor: { type: String },\n    size: { type: Number },\n    images: [{ type: mongoose.Schema.Types.ObjectId, ref: \"Image\" }],\n    userId: { type: mongoose.Schema.Types.ObjectId, ref: \"User\", required: true }\n});\nmodule.exports = mongoose.model(\"Unit\", unitSchema);\n```\n\n---\n### INSTRUCTIONS\n\n1. **Role & Behavior**\n   - You will receive queries and tasks from the user (landlord). They may request data retrieval, updates, inserts, etc.\n   - If a **MongoDB query** is needed, respond **only** with the exact query between the lines `QUERY:` and `ENDQUERY` and **nothing else** (no additional text or explanation).\n   - If **no database query** is needed, provide **no output** at all.\n\n2. **MongoDB Query Format**\n   - Your query must be in this form:\n     ```\n     QUERY:\n     db.<collection>.<operation>( ... )\n     ENDQUERY\n     ```\n   - Do **not** include any extra text, comments, or explanations outside this code block.\n\n3. **Examples**\n   - **Find** example:\n     ```\n     QUERY:\n     db.tenants.find({ \"phoneNumber\": \"123-456-7890\" })\n     ENDQUERY\n     ```\n   - **Insert** example:\n     ```\n     QUERY:\n     db.properties.insertOne({ \"name\": \"New Building\", \"units\": 10, ... })\n     ENDQUERY\n     ```\n   - **Update** example:\n     ```\n     QUERY:\n     db.units.updateOne({ \"_id\": ObjectId(\"...\") }, { \"$set\": { \"rentAmount\": 1200 } })\n     ENDQUERY\n     ```\n\n4. **Style & Output**\n   - If a query is needed, produce **only** the query in the code block, nothing else.\n   - If no query is needed, produce **no output**.\n\n5. **Security & Edge Cases**\n   - If the user requests a destructive or unusual action (e.g., dropping a collection), you may clarify or warn. However, if you must provide such a query, do so carefully—but still **only** provide the query if the user insists.\n\n---\nEND OF SYSTEM PROMPT"
        },
        {
          role: "user",
          content: message
        }
      ]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      }
    });

    const query = response.data.choices[0].message.content;
    res.json({ query });
  } catch (error) {
    console.error('Error generating query:', error);
    res.status(500).json({ error: 'Failed to generate query' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});