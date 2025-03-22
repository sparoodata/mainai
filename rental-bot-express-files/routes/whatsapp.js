// WhatsApp integration for rental property management chatbot
const express = require('express');
const router = express.Router();
const axios = require('axios');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const fs = require('fs');
const path = require('path');

// Utils
const helpers = require('../utils/helpers');
const groqAI = require('../utils/groqAI');
const zepMemory = require('../utils/zepMemory');
const botConversation = require('../utils/botConversation');

// WhatsApp API configuration
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN;

/**
 * Process incoming WhatsApp messages
 */
router.post('/webhook', async (req, res) => {
  try {
    // Verify webhook
    if (req.body.object === 'whatsapp_business_account') {
      if (req.body.entry && 
          req.body.entry[0].changes && 
          req.body.entry[0].changes[0].value.messages && 
          req.body.entry[0].changes[0].value.messages[0]) {
        
        const message = req.body.entry[0].changes[0].value.messages[0];
        const from = message.from; // User's WhatsApp number
        
        // Process different message types
        let messageText = '';
        let mediaUrl = null;
        
        if (message.type === 'text') {
          messageText = message.text.body;
        } else if (message.type === 'image' || message.type === 'document') {
          // Get media ID
          const mediaId = message.image ? message.image.id : message.document.id;
          
          // Download media
          mediaUrl = await downloadWhatsAppMedia(mediaId);
          
          // If there's a caption, use it as message text
          messageText = message.caption || 'File uploaded';
        }
        
        // Process message with our chatbot
        const response = await processWhatsAppMessage(from, messageText, mediaUrl);
        
        // Send response back to WhatsApp
        await sendWhatsAppMessage(from, response);
        
        res.sendStatus(200);
      } else {
        // Not a message notification
        res.sendStatus(200);
      }
    } else {
      // Not from WhatsApp
      res.sendStatus(404);
    }
  } catch (error) {
    console.error('Error in WhatsApp webhook:', error);
    res.sendStatus(500);
  }
});

/**
 * WhatsApp verification endpoint
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  // Check if a token and mode is in the query string
  if (mode && token) {
    // Check the mode and token
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      // Respond with the challenge token
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      // Respond with '403 Forbidden' if verify tokens do not match
      res.sendStatus(403);
    }
  } else {
    // Missing query parameters
    res.sendStatus(400);
  }
});

/**
 * Process WhatsApp message with our chatbot
 * @param {string} userId - User's WhatsApp number
 * @param {string} message - Message text
 * @param {string} mediaUrl - URL of uploaded media (if any)
 * @returns {Promise<string>} Bot response
 */
async function processWhatsAppMessage(userId, message, mediaUrl) {
  try {
    // Save user message to memory
    await zepMemory.addMemory(userId, message);
    
    // Handle media if present
    let fileData = null;
    if (mediaUrl) {
      // Download file from URL
      const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data, 'binary');
      
      // Create temporary file
      const tempFilePath = path.join('uploads', `whatsapp_${Date.now()}`);
      fs.writeFileSync(tempFilePath, buffer);
      
      // Create file object similar to multer
      const file = {
        path: tempFilePath,
        originalname: path.basename(mediaUrl),
        mimetype: response.headers['content-type']
      };
      
      // Upload to R2
      fileData = await helpers.uploadImageWithThumbnail(file, userId, 'chat');
    }
    
    // Check if we're in the middle of a conversation flow
    const conversationResponse = await botConversation.processMessage(userId, message);
    if (conversationResponse) {
      return conversationResponse;
    }
    
    // Check for specific commands
    const lowerMessage = message.toLowerCase();
    
    // Command: Add Property
    if (lowerMessage.includes('add property') || lowerMessage.includes('new property')) {
      const response = botConversation.startFlow(userId, 'ADD_PROPERTY');
      await zepMemory.addMemory(userId, response, false);
      return response;
    }
    
    // Command: Add Unit
    else if (lowerMessage.includes('add unit') || lowerMessage.includes('new unit')) {
      // Implementation similar to webhook.js
      // ...
      
      // For brevity, we'll just call the same function
      // In a real implementation, you would handle this similarly to webhook.js
      const response = await handleAddUnitCommand(userId);
      return response;
    }
    
    // Command: Add Tenant
    else if (lowerMessage.includes('add tenant') || lowerMessage.includes('new tenant')) {
      // Implementation similar to webhook.js
      // ...
      
      // For brevity, we'll just call the same function
      const response = await handleAddTenantCommand(userId);
      return response;
    }
    
    // Other commands (list properties, list units, list tenants, get summary)
    // Would be implemented similarly to webhook.js
    // ...
    
    // Process with Groq for general conversation
    const response = await groqAI.processWithGroq(userId, 
      fileData ? `${message} [Uploaded file: ${fileData.filename} - ${fileData.url}]` : message
    );
    
    return response;
  } catch (error) {
    console.error('Error processing WhatsApp message:', error);
    return "I'm having trouble processing your request right now. Please try again later.";
  }
}

/**
 * Send message to WhatsApp user
 * @param {string} to - User's WhatsApp number
 * @param {string} message - Message to send
 * @returns {Promise<void>}
 */
async function sendWhatsAppMessage(to, message) {
  try {
    // Check if message contains HTML img tags
    const hasImages = /<img.*?src="(.*?)".*?>/g.test(message);
    
    if (hasImages) {
      // Extract image URLs
      const imgRegex = /<img.*?src="(.*?)".*?>/g;
      const imgUrls = [];
      let match;
      
      while ((match = imgRegex.exec(message)) !== null) {
        imgUrls.push(match[1]);
      }
      
      // Replace HTML with plain text
      const plainText = message.replace(/<img.*?>/g, '[Image]')
                               .replace(/<.*?>/g, '')
                               .trim();
      
      // Send text message
      await axios.post(`${WHATSAPP_API_URL}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: plainText }
      }, {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      
      // Send images
      for (const imgUrl of imgUrls) {
        await axios.post(`${WHATSAPP_API_URL}/messages`, {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          type: 'image',
          image: { link: imgUrl }
        }, {
          headers: {
            'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });
      }
    } else {
      // Send text message
      await axios.post(`${WHATSAPP_API_URL}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: message }
      }, {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
    }
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
  }
}

/**
 * Download media from WhatsApp
 * @param {string} mediaId - WhatsApp media ID
 * @returns {Promise<string>} Media URL
 */
async function downloadWhatsAppMedia(mediaId) {
  try {
    // Get media URL
    const response = await axios.get(`${WHATSAPP_API_URL}/${mediaId}`, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`
      }
    });
    
    return response.data.url;
  } catch (error) {
    console.error('Error downloading WhatsApp media:', error);
    throw error;
  }
}

// Helper functions for commands (would contain similar logic to webhook.js)
async function handleAddUnitCommand(userId) {
  // Implementation similar to webhook.js
  // ...
  
  // This is a placeholder - in a real implementation, you would handle this similarly to webhook.js
  return "I'll help you add a new unit. Please tell me which property you'd like to add it to.";
}

async function handleAddTenantCommand(userId) {
  // Implementation similar to webhook.js
  // ...
  
  // This is a placeholder - in a real implementation, you would handle this similarly to webhook.js
  return "I'll help you add a new tenant. Please tell me which unit you'd like to assign to the tenant.";
}

module.exports = router;
