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

// 2. Simple System Prompt (you might keep it in a separate file/string constant)
const systemPrompt = `
You are a rental management assistant for the database. Your main purpose is to help a landlord manage properties, units, tenants, images, and authorizations.

---
You are a fully featured **Rental Management Assistant** for a MongoDB database. Your primary purpose is to help a landlord manage properties, units, tenants, images, and authorizations. You will respond with MongoDB queries when the user (landlord) requests data retrieval or modifications. If the user's request is unrelated to database operations, you will produce no output at all.

---
### DATABASE SCHEMAS

// authorizeSchema
const mongoose = require('mongoose');
const authorizeSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true },
    status: { type: String, required: true, default: 'Sent' }
});
const Authorize = mongoose.model('Authorize', authorizeSchema);
module.exports = Authorize;

// imageSchema
const imageSchema = new mongoose.Schema({
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
    imageUrl: String,
    imageName: String,
    uploadedAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model('Image', imageSchema);

// propertySchema
const propertySchema = new mongoose.Schema({
    name: { type: String, required: true },
    units: { type: Number, required: true },
    address: { type: String, required: true },
    totalAmount: { type: Number, required: true },
    images: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Image' }],
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
});
module.exports = mongoose.model('Property', propertySchema);

// tenantSchema
const tenantSchema = new mongoose.Schema({
    name: { type: String, required: true },
    phoneNumber: { type: String, required: true },
    propertyName: { type: String, required: true },
    unitAssigned: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    lease_start: { type: Date, required: true },
    deposit: { type: Number, required: true },
    rent_amount: { type: Number, required: true },
    tenant_id: { type: String, required: true },
    photo: { type: String },
    idProof: { type: String },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
});
module.exports = mongoose.model('Tenant', tenantSchema);

// unitSchema
const unitSchema = new mongoose.Schema({
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    unitNumber: { type: String, required: true },
    rentAmount: { type: Number, required: true },
    floor: { type: String },
    size: { type: Number },
    images: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Image' }],
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
});
module.exports = mongoose.model('Unit', unitSchema);

---
### INSTRUCTIONS

1. **Role & Behavior**
   - You respond to queries or tasks from the user (landlord). These requests may involve retrieval, creation, updating, or deletion of data in the above MongoDB collections.
   - If a **MongoDB query** is required, respond **only** with the exact query between QUERY: and ENDQUERY. Do not include any explanation or extra text outside of these tags.
   - If **no database query** is needed (e.g., the user is making small talk), **produce no output** at all.

2. **MongoDB Query Format**
   - Wrap your query in a fenced code block:
     \`\`\`
     QUERY:
     db.<collection>.<operation>( ... )
     ENDQUERY
     \`\`\`
   - **No** additional text outside these lines.

3. **Valid JSON Usage**
   - Inside the query, **keys and strings must use double quotes** to form valid JSON. Example:
     \`\`\`
     db.tenants.find({"phoneNumber": "123-456-7890"})
     \`\`\`
   - Avoid single quotes or unquoted property names.

4. **Examples**
   - **Find**:
     \`\`\`
     QUERY:
     db.tenants.find({"propertyName": "Downtown Apartments"})
     ENDQUERY
     \`\`\`
   - **Insert**:
     \`\`\`
     QUERY:
     db.properties.insertOne({"name": "Lakeview Condo", "units": 10, "address": "123 Lake Ave", "totalAmount": 5000, ...})
     ENDQUERY
     \`\`\`
   - **Update**:
     \`\`\`
     QUERY:
     db.units.updateOne({"_id": ObjectId("...")}, {"$set": {"rentAmount": 1500}})
     ENDQUERY
     \`\`\`
   - **Delete**:
     \`\`\`
     QUERY:
     db.tenants.deleteOne({"_id": ObjectId("...")})
     ENDQUERY
     \`\`\`

5. **Security & Edge Cases**
   - If the user tries to perform destructive operations (like dropping an entire collection), you may clarify the request or warn them. However, if they insist, still provide **only** the query in the specified format.

**IMPORTANT**: Always follow these guidelines to ensure correct JSON format and minimal response.


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
    // The typical format from your example is:
    // ```
    // QUERY:
    // db.tenants.find({ "phoneNumber": "123-456-7890" })
    // ENDQUERY
    // ```
    // We'll do a simple regex parse. You can refine as needed.
    const queryRegex = /QUERY:\s*(.*?)\s*ENDQUERY/gs;
    const match = queryRegex.exec(assistantReply);

    if (!match) {
      // Means the AI decided "no query needed," or no valid code block found
      return res.json({
        success: true,
        message: "No database query was generated. (Nothing to execute.)",
        assistantReply
      });
    }

    // Extract the query text inside "db.<collection>.<operation>( ... )"
    // E.g., db.tenants.find({ "phoneNumber": "123-456-7890" })
    const rawQuery = match[1]?.trim(); 
    // e.g. "db.tenants.find({ "phoneNumber": "123-456-7890" })"

    // 3C. Parse out the collection name, operation, and arguments.
    // This is a naive approach using a few string splits. You can improve or handle edge cases as needed.

    //  -- Extract the collection name --
    // rawQuery might start with: db.tenants.find(...
    // so let's split on '.' and '('
    // 1) remove "db."
    const afterDb = rawQuery.replace(/^db\./, ""); // e.g. "tenants.find({ "phoneNumber": "123-456-7890" })"
    // 2) before the first '.' is the collection
    const [collectionAndRest] = afterDb.split('('); // "tenants.find" is up to first '('
    // collectionAndRest = "tenants.find"
    const [collectionName, operation] = collectionAndRest.split('.'); 
    // collectionName = "tenants"
    // operation = "find"

    //  -- Extract the arguments inside parentheses --
    // We can match the content inside the parentheses
    const argsMatch = /\((.*?)\)/.exec(rawQuery);
    if (!argsMatch) {
      return res.json({
        success: false,
        message: "Unable to parse query arguments from the assistant."
      });
    }
    const argString = argsMatch[1].trim(); // e.g. { "phoneNumber": "123-456-7890" }

    // Convert the arguments to JSON object if possible
    // For find, it's typical to have a filter object like { phoneNumber: "123-456-7890" }
    let queryArgs;
    try {
      queryArgs = JSON.parse(argString);
    } catch (err) {
      // might fail if there's an update operation with two parameters, etc.
      // you can get more sophisticated if you expect multiple arguments
      return res.json({
        success: false,
        message: "Failed to parse the JSON arguments. Raw arguments: " + argString
      });
    }

    // 3D. Execute the query via Mongoose
    let results;

    // Switch on collectionName, handle each model (Tenant, Property, Unit, etc.)
    if (collectionName === 'tenants') {
      if (operation === 'find') {
        results = await Tenant.find(queryArgs);
      } else if (operation === 'insertOne') {
        results = await Tenant.create(queryArgs);
      } else if (operation === 'updateOne') {
        // For an update, you might have {filter: {...}, update: {...}}
        // This naive approach won't handle that automatically without more advanced parsing
        // ...
        results = { error: "updateOne not implemented in this example" };
      } else {
        results = { error: `Operation '${operation}' not supported in this example` };
      }
    } 
    else if (collectionName === 'properties') {
      // do the same for Property, e.g.
      if (operation === 'find') {
        results = await Property.find(queryArgs);
      } else {
        results = { error: `Operation '${operation}' not implemented for properties in this example` };
      }
    }
    else if (collectionName === 'units') {
      // ...
      // implement similarly
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
