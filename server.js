

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const fetch = require('node-fetch'); // or `axios`
const Tenant = require('./models/Tenant'); // import your models
const Property = require('./models/Property');
const Unit = require('./models/Unit');
const Image = require('./models/Image');
const Authorize = require('./models/Authorize');

const app = express();
app.use(express.json());

// 1. Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log("MongoDB connected"))
.catch((err) => console.error("MongoDB connection error:", err));

// 2. Simple System Prompt
const systemPrompt = `
You are a rental management assistant for the database. Your main purpose is to help a landlord manage properties, units, tenants, images, and authorizations.

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

3. **Examples**
   - **Find** example:
     \`\`\`
     QUERY:
     db.tenants.find({ "phoneNumber": "123-456-7890" })
     ENDQUERY
     \`\`\`
   - **Insert** example:
     \`\`\`
     QUERY:
     db.properties.insertOne({ "name": "New Building", "units": 10, ... })
     ENDQUERY
     \`\`\`
   - **Update** example:
     \`\`\`
     QUERY:
     db.units.updateOne({ "_id": ObjectId("...") }, { "$set": { "rentAmount": 1200 } })
     ENDQUERY
     \`\`\`

4. **Style & Output**
   - If a query is needed, produce **only** the query in the code block, nothing else.
   - If no query is needed, produce **no output**.

5. **Security & Edge Cases**
   - If the user requests a destructive or unusual action (e.g., dropping a collection), you may clarify or warn. However, if you must provide such a query, do so carefully—but still **only** provide the query if the user insists.

---
END OF SYSTEM PROMPT
`.trim();

// 3. Endpoint to handle user messages
app.post('/chat', async (req, res) => {
  try {
    const userMessage = req.body.message; // the message user typed

    // 3A. Send the conversation to Groq/OpenAI
    //     - We'll pass systemPrompt as the first (system) message
    //     - Then the user message as the second
    const apiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile", // example model
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ]
      })
    });
    
    const data = await apiResponse.json();
    // The assistant's reply (potentially containing the Mongo query)
    const assistantReply = data.choices?.[0]?.message?.content || "";

    // 3B. Check if there's a code block with QUERY
    const queryRegex = /QUERY:\s*(.*?)\s*ENDQUERY/gs;
    const match = queryRegex.exec(assistantReply);
    console.log(assistantReply);

    if (!match) {
      // Means the AI decided "no query needed," or no valid code block found
      return res.json({
        success: true,
        message: "No database query was generated. (Nothing to execute.)",
        assistantReply
      });
    }

    // Extract the query text inside "db.<collection>.<operation>( ... )"
    const rawQuery = match[1]?.trim(); 
    console.log(rawQuery);

    // 3C. Parse out the collection name, operation, and arguments.
    const afterDb = rawQuery.replace(/^db\./, "");
    const [collectionAndRest] = afterDb.split('(');
    console.log(collectionAndRest.split('.'));
    const [collectionName, operation] = collectionAndRest.split('.');

    const argsMatch = /\((.*?)\)/.exec(rawQuery);
    console.log(argsMatch);
    if (!argsMatch) {
      return res.json({
        success: false,
        message: "Unable to parse query arguments from the assistant."
      });
    }
    const argString = argsMatch[1].trim();
    console.log(argString);
    let queryArgs;
    try {
      queryArgs = JSON.parse(argString);
      
    } catch (err) {
      return res.json({
        success: false,
        message: "Failed to parse the JSON arguments. Raw arguments: " + argString
      });
    }

    // 3D. Execute the query via Mongoose
    let results;

    if (collectionName === 'tenants') {
      if (operation === 'find') {
        results = await Tenant.find(queryArgs);
      } else if (operation === 'insertOne') {
        results = await Tenant.create(queryArgs);
      } else {
        results = { error: `Operation '${operation}' not implemented in this example` };
      }
    } 
    else if (collectionName === 'properties') {
      if (operation === 'find') {
        results = await Property.find(queryArgs);
      } else {
        results = { error: `Operation '${operation}' not implemented for properties in this example` };
      }
    }
    else if (collectionName === 'units') {
      results = { error: `Collection 'units' not implemented in this example` };
    }
    else {
      results = { error: `Unknown collection: ${collectionName}` };
    }

    // 3E. Return the query + results to the user
    return res.json({
      success: true,
      rawQuery,
      collectionName,
      operation,
      args: queryArgs,
      results
    });

  } catch (error) {
    console.error("Error in /chat route:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
