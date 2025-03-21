const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const fs = require('fs');
const path = require('path');

// Models
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Tenant = require('../models/Tenant');
const User = require('../models/User');

// Utils
const helpers = require('../utils/helpers');
const groqAI = require('../utils/groqAI');
const zepMemory = require('../utils/zepMemory');
const botConversation = require('../utils/botConversation');

/**
 * Process chatbot messages and handle property management commands
 */
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const { userId, message } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    // Save user message to memory
    await zepMemory.addMemory(userId, message);
    
    // Handle file upload if present
    let fileData = null;
    if (req.file) {
      fileData = await helpers.uploadImageWithThumbnail(req.file, userId, 'chat');
    }
    
    // Check if we're in the middle of a conversation flow
    const conversationResponse = await botConversation.processMessage(userId, message);
    if (conversationResponse) {
      return res.json({ response: conversationResponse });
    }
    
    // Check for specific commands
    const lowerMessage = message.toLowerCase();
    let response;
    
    // Command: Add Property
    if (lowerMessage.includes('add property') || lowerMessage.includes('new property')) {
      response = botConversation.startFlow(userId, 'ADD_PROPERTY');
      await zepMemory.addMemory(userId, response, false);
      return res.json({ response });
    }
    
    // Command: Add Unit
    else if (lowerMessage.includes('add unit') || lowerMessage.includes('new unit')) {
      // Get properties for selection
      const properties = await Property.find({}).sort({ name: 1 });
      
      if (properties.length === 0) {
        response = "You don't have any properties yet. Please add a property first before adding units.";
        await zepMemory.addMemory(userId, response, false);
        return res.json({ response });
      }
      
      let propertyList;
      if (properties.length > 10) {
        // Show first 10 with option to see more
        propertyList = properties.slice(0, 10).map((p, i) => `${i+1}. ${p.name} (${p.address})`).join('\n');
        propertyList += "\n\nPlease select a property by number or type 'more' to see additional properties.";
      } else {
        // Show all properties
        propertyList = properties.map((p, i) => `${i+1}. ${p.name} (${p.address})`).join('\n');
        propertyList += "\n\nPlease select a property by number to add a unit to.";
      }
      
      response = `I'll help you add a new unit. Which property would you like to add it to?\n\n${propertyList}`;
      await zepMemory.addMemory(userId, response, false);
      
      // Start the ADD_UNIT flow
      botConversation.startFlow(userId, 'ADD_UNIT');
      
      return res.json({ response });
    }
    
    // Command: Add Tenant
    else if (lowerMessage.includes('add tenant') || lowerMessage.includes('new tenant')) {
      // Get available units for selection
      const units = await Unit.find({ isAvailable: true })
        .populate('property')
        .sort({ unitId: 1 });
      
      if (units.length === 0) {
        response = "You don't have any available units. Please add a unit or make an existing unit available before adding tenants.";
        await zepMemory.addMemory(userId, response, false);
        return res.json({ response });
      }
      
      let unitList;
      if (units.length > 10) {
        // Show first 10 with option to see more
        unitList = units.slice(0, 10).map((u, i) => `${i+1}. ${u.unitId} - ${u.property.name}, Floor ${u.floor}, $${u.rent}/month`).join('\n');
        unitList += "\n\nPlease select a unit by number or type 'more' to see additional units.";
      } else {
        // Show all units
        unitList = units.map((u, i) => `${i+1}. ${u.unitId} - ${u.property.name}, Floor ${u.floor}, $${u.rent}/month`).join('\n');
        unitList += "\n\nPlease select a unit by number to add a tenant to.";
      }
      
      response = `I'll help you add a new tenant. Which unit would you like to assign to the tenant?\n\n${unitList}`;
      await zepMemory.addMemory(userId, response, false);
      
      // Start the ADD_TENANT flow
      botConversation.startFlow(userId, 'ADD_TENANT');
      
      return res.json({ response });
    }
    
    // Command: List Properties
    else if (lowerMessage.includes('list properties') || lowerMessage.includes('show properties')) {
      const properties = await Property.find({}).sort({ name: 1 });
      
      if (properties.length === 0) {
        response = "You don't have any properties yet. You can add a property by saying 'add property'.";
        await zepMemory.addMemory(userId, response, false);
        return res.json({ response });
      }
      
      let propertyList;
      if (properties.length > 10) {
        // Show first 10 with option to see more
        propertyList = properties.slice(0, 10).map((p, i) => `${i+1}. ${p.name} (${p.address}) - ${p.type}, ${p.size} sq ft`).join('\n');
        propertyList += "\n\nShowing 10 of " + properties.length + " properties. Type 'more properties' to see additional properties.";
      } else {
        // Show all properties
        propertyList = properties.map((p, i) => `${i+1}. ${p.name} (${p.address}) - ${p.type}, ${p.size} sq ft`).join('\n');
      }
      
      response = `Here are your properties:\n\n${propertyList}`;
      await zepMemory.addMemory(userId, response, false);
      return res.json({ response });
    }
    
    // Command: List Units
    else if (lowerMessage.includes('list units') || lowerMessage.includes('show units')) {
      // Check if property name is specified
      const propertyMatch = message.match(/for\s+(.+?)(?:\s|$)/i);
      let units;
      
      if (propertyMatch) {
        const propertyName = propertyMatch[1];
        const property = await Property.findOne({ name: { $regex: propertyName, $options: 'i' } });
        
        if (!property) {
          response = `I couldn't find a property named "${propertyName}". Please check the name and try again.`;
          await zepMemory.addMemory(userId, response, false);
          return res.json({ response });
        }
        
        units = await Unit.find({ property: property._id }).sort({ unitId: 1 });
        
        if (units.length === 0) {
          response = `The property "${property.name}" doesn't have any units yet. You can add a unit by saying 'add unit'.`;
          await zepMemory.addMemory(userId, response, false);
          return res.json({ response });
        }
      } else {
        units = await Unit.find({})
          .populate('property')
          .sort({ unitId: 1 });
        
        if (units.length === 0) {
          response = "You don't have any units yet. You can add a unit by saying 'add unit'.";
          await zepMemory.addMemory(userId, response, false);
          return res.json({ response });
        }
      }
      
      let unitList;
      if (units.length > 10) {
        // Show first 10 with option to see more
        unitList = units.slice(0, 10).map((u, i) => {
          const propertyName = u.property ? u.property.name : 'Unknown Property';
          return `${i+1}. ${u.unitId} - ${propertyName}, Floor ${u.floor}, $${u.rent}/month, ${u.isAvailable ? 'Available' : 'Occupied'}`;
        }).join('\n');
        unitList += "\n\nShowing 10 of " + units.length + " units. Type 'more units' to see additional units.";
      } else {
        // Show all units
        unitList = units.map((u, i) => {
          const propertyName = u.property ? u.property.name : 'Unknown Property';
          return `${i+1}. ${u.unitId} - ${propertyName}, Floor ${u.floor}, $${u.rent}/month, ${u.isAvailable ? 'Available' : 'Occupied'}`;
        }).join('\n');
      }
      
      response = `Here are your units:\n\n${unitList}`;
      await zepMemory.addMemory(userId, response, false);
      return res.json({ response });
    }
    
    // Command: List Tenants
    else if (lowerMessage.includes('list tenants') || lowerMessage.includes('show tenants')) {
      // Check if property or unit is specified
      const propertyMatch = message.match(/property\s+(.+?)(?:\s|$)/i);
      const unitMatch = message.match(/unit\s+([A-Z0-9]+)(?:\s|$)/i);
      let tenants;
      
      if (unitMatch) {
        const unitId = unitMatch[1];
        const unit = await Unit.findOne({ unitId });
        
        if (!unit) {
          response = `I couldn't find a unit with ID "${unitId}". Please check the ID and try again.`;
          await zepMemory.addMemory(userId, response, false);
          return res.json({ response });
        }
        
        tenants = await Tenant.find({ unit: unit._id }).sort({ name: 1 });
        
        if (tenants.length === 0) {
          response = `The unit "${unitId}" doesn't have any tenants yet. You can add a tenant by saying 'add tenant'.`;
          await zepMemory.addMemory(userId, response, false);
          return res.json({ response });
        }
      } else if (propertyMatch) {
        const propertyName = propertyMatch[1];
        const property = await Property.findOne({ name: { $regex: propertyName, $options: 'i' } });
        
        if (!property) {
          response = `I couldn't find a property named "${propertyName}". Please check the name and try again.`;
          await zepMemory.addMemory(userId, response, false);
          return res.json({ response });
        }
        
        const units = await Unit.find({ property: property._id });
        const unitIds = units.map(unit => unit._id);
        
        tenants = await Tenant.find({ unit: { $in: unitIds } })
          .populate('unit')
          .sort({ name: 1 });
        
        if (tenants.length === 0) {
          response = `The property "${property.name}" doesn't have any tenants yet. You can add a tenant by saying 'add tenant'.`;
          await zepMemory.addMemory(userId, response, false);
          return res.json({ response });
        }
      } else {
        tenants = await Tenant.find({})
          .populate('unit')
          .sort({ name: 1 });
        
        if (tenants.length === 0) {
          response = "You don't have any tenants yet. You can add a tenant by saying 'add tenant'.";
          await zepMemory.addMemory(userId, response, false);
          return res.json({ response });
        }
      }
      
      let tenantList;
      if (tenants.length > 10) {
        // Show first 10 with option to see more
        tenantList = tenants.slice(0, 10).map((t, i) => {
          const unitId = t.unit ? t.unit.unitId : 'Unknown Unit';
          return `${i+1}. ${t.tenantId} - ${t.name}, Unit: ${unitId}, Move-in: ${new Date(t.moveInDate).toLocaleDateString()}, Rent: $${t.rentInfo.amount}/month`;
        }).join('\n');
        tenantList += "\n\nShowing 10 of " + tenants.length + " tenants. Type 'more tenants' to see additional tenants.";
      } else {
        // Show all tenants
        tenantList = tenants.map((t, i) => {
          const unitId = t.unit ? t.unit.unitId : 'Unknown Unit';
          return `${i+1}. ${t.tenantId} - ${t.name}, Unit: ${unitId}, Move-in: ${new Date(t.moveInDate).toLocaleDateString()}, Rent: $${t.rentInfo.amount}/month`;
        }).join('\n');
      }
      
      response = `Here are your tenants:\n\n${tenantList}`;
      await zepMemory.addMemory(userId, response, false);
      return res.json({ response });
    }
    
    // Command: Get Summary
    else if (lowerMessage.includes('summary') || lowerMessage.includes('get summary')) {
      // Check if property, unit, or tenant is specified
      const propertyMatch = message.match(/property\s+(.+?)(?:\s|$)/i);
      const unitMatch = message.match(/unit\s+([A-Z0-9]+)(?:\s|$)/i);
      const tenantMatch = message.match(/tenant\s+([A-Z0-9]+)(?:\s|$)/i);
      
      let summary;
      
      if (tenantMatch) {
        const tenantId = tenantMatch[1];
        const tenant = await Tenant.findOne({ tenantId })
          .populate({
            path: 'unit',
            populate: {
              path: 'property'
            }
          });
        
        if (!tenant) {
          response = `I couldn't find a tenant with ID "${tenantId}". Please check the ID and try again.`;
          await zepMemory.addMemory(userId, response, false);
          return res.json({ response });
        }
        
        summary = await groqAI.generateEntitySummary(userId, 'tenant', tenant);
      } else if (unitMatch) {
        const unitId = unitMatch[1];
        const unit = await Unit.findOne({ unitId }).populate('property');
        
        if (!unit) {
          response = `I couldn't find a unit with ID "${unitId}". Please check the ID and try again.`;
          await zepMemory.addMemory(userId, response, false);
          return res.json({ response });
        }
        
        summary = await groqAI.generateEntitySummary(userId, 'unit', unit);
      } else if (propertyMatch) {
        const propertyName = propertyMatch[1];
        const property = await Property.findOne({ name: { $regex: propertyName, $options: 'i' } });
        
        if (!property) {
          response = `I couldn't find a property named "${propertyName}". Please check the name and try again.`;
          await zepMemory.addMemory(userId, response, false);
          return res.json({ response });
        }
        
        summary = await groqAI.generateEntitySummary(userId, 'property', property);
      } else {
        response = "Please specify what you'd like a summary of. For example: 'get summary for property Sunset Apartments' or 'get summary for tenant T1234A'.";
        await zepMemory.addMemory(userId, response, false);
        return res.json({ response });
      }
      
      await zepMemory.addMemory(userId, summary, false);
      return res.json({ response: summary });
    }
    
    // Command: More (pagination)
    else if (lowerMessage === 'more' || lowerMessage.includes('more properties') || 
             lowerMessage.includes('more units') || lowerMessage.includes('more tenants')) {
      // Get conversation history to determine what to show more of
      const history = await zepMemory.getMemory(userId, 5);
      const botMessages = history.filter(msg => msg.role === 'assistant');
      
      if (botMessages.length === 0) {
        response = "I'm not sure what you want to see more of. Please specify if you want to see properties, units, or tenants.";
        await zepMemory.addMemory(userId, response, false);
        return res.json({ response });
      }
      
      const lastBotMessage = botMessages[botMessages.length - 1].content;
      
      // Determine what type of list to paginate
      let listType = '';
      if (lowerMessage.includes('properties') || lastBotMessage.includes('properties')) {
        listType = 'properties';
      } else if (lowerMessage.includes('units') || lastBotMessage.includes('units')) {
        listType = 'units';
      } else if (lowerMessage.includes('tenants') || lastBotMessage.includes('tenants')) {
        listType = 'tenants';
      } else {
        response = "I'm not sure what you want to see more of. Please specify if you want to see more properties, units, or tenants.";
        await zepMemory.addMemory(userId, response, false);
        return res.json({ response });
      }
      
      // Get current page from last message
      const currentPageMatch = lastBotMessage.match(/Showing \d+ of (\d+)/);
      if (!currentPageMatch) {
        response = `I don't have any additional ${listType} to show.`;
        await zepMemory.addMemory(userId, response, false);
        return res.json({ response });
      }
      
      const totalItems = parseInt(currentPageMatch[1], 10);
      const currentPage = Math.floor(10 / totalItems);
      const nextPage = currentPage + 1;
      
      // Get items based on type
      let items;
      switch (listType) {
        case 'properties':
          items = await Property.find({}).sort({ name: 1 });
          break;
        case 'units':
          items = await Unit.find({}).populate('property').sort({ unitId: 1 });
          break;
        case 'tenants':
          items = await Tenant.find({}).populate('unit').sort({ name: 1 });
          break;
      }
      
      // Calculate start and end indices for pagination
      const startIdx = nextPage * 10;
      const endIdx = Math.min(startIdx + 10, items.length);
      
      // If no more items to show
      if (startIdx >= items.length) {
        response = `There are no more ${listType} to show.`;
        await zepMemory.addMemory(userId, response, false);
        return res.json({ response });
      }
      
      // Format items based on type
      let itemList;
      if (listType === 'properties') {
        itemList = items.slice(startIdx, endIdx).map((p, i) => 
          `${startIdx + i + 1}. ${p.name} (${p.address}) - ${p.type}, ${p.size} sq ft`
        ).join('\n');
      } else if (listType === 'units') {
        itemList = items.slice(startIdx, endIdx).map((u, i) => {
          const propertyName = u.property ? u.property.name : 'Unknown Property';
          return `${startIdx + i + 1}. ${u.unitId} - ${propertyName}, Floor ${u.floor}, $${u.rent}/month, ${u.isAvailable ? 'Available' : 'Occupied'}`;
        }).join('\n');
      } else if (listType === 'tenants') {
        itemList = items.slice(startIdx, endIdx).map((t, i) => {
          const unitId = t.unit ? t.unit.unitId : 'Unknown Unit';
          return `${startIdx + i + 1}. ${t.tenantId} - ${t.name}, Unit: ${unitId}, Move-in: ${new Date(t.moveInDate).toLocaleDateString()}, Rent: $${t.rentInfo.amount}/month`;
        }).join('\n');
      }
      
      // Add pagination info if needed
      if (endIdx < items.length) {
        itemList += `\n\nShowing ${startIdx + 1}-${endIdx} of ${items.length} ${listType}. Type 'more ${listType}' to see additional ${listType}.`;
      }
      
      response = `Here are more ${listType}:\n\n${itemList}`;
      await zepMemory.addMemory(userId, response, false);
      return res.json({ response });
    }
    
    // Process with Groq for general conversation
    response = await groqAI.processWithGroq(userId, 
      fileData ? `${message} [Uploaded file: ${fileData.filename} - ${fileData.url}]` : message
    );
    
    return res.json({ response });
  } catch (error) {
    console.error('Error in webhook:', error);
    return res.status(500).json(helpers.formatError(error, 'webhook_process'));
  }
});

module.exports = router;
