const axios = require('axios');

/**
 * Process message with Groq AI
 * @param {string} userId - User identifier
 * @param {string} message - User message
 * @param {Array} history - Conversation history
 * @returns {Promise<string>} AI response
 */
async function processWithGroq(userId, message, history) {
  try {
    // Check if Groq API key is configured
    if (!process.env.GROQ_API_KEY) {
      console.error('GROQ_API_KEY is not configured');
      return "I'm sorry, but I'm not properly configured. Please contact the administrator.";
    }
    
    // Format history for Groq
    const formattedHistory = history.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
    
    // Add system message with instructions
    const systemMessage = {
      role: "system",
      content: `You are a helpful rental property management assistant for landlords. Your name is PropertyBot.

CAPABILITIES:
- Help landlords manage properties, units, and tenants through interactive conversations
- Add new properties, units, and tenants by asking questions one at a time
- Display property, unit, and tenant information in a clear format
- Show summaries with embedded image thumbnails when requested
- Remember conversation context

PROPERTY MANAGEMENT RULES:
- Properties have: name, address, type, size
- Units have: auto-generated unitId (like U1234A), floor, rent, availability
- Tenants have: auto-generated tenantId, name, contact, unitId, move-in date, rent info

CONVERSATION GUIDELINES:
- Be concise and helpful
- Ask one question at a time when collecting information
- When showing lists with more than 10 items, offer a menu
- When showing lists with 10 or fewer items, show a numbered list
- When showing summaries, include image thumbnails inline using HTML img tags
- Use the command "summary" or "get summary" to retrieve unit/tenant summaries

RESPONSE FORMAT:
- For normal responses: Clear, concise text
- For summaries: Include HTML img tags to display images inline
- For lists: Numbered format for 10 or fewer items, menu format for more

Always maintain a helpful, professional tone and focus on assisting with property management tasks.`
    };
    
    // Using axios instead of groq-sdk for better Node.js 16 compatibility
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: "llama3-70b-8192",
        messages: [
          systemMessage,
          ...formattedHistory,
          {
            role: "user",
            content: message
          }
        ],
        temperature: 0.7,
        max_tokens: 1024,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Extract response content
    return response.data.choices[0].message.content || "I'm sorry, I couldn't process your request.";
  } catch (error) {
    console.error('Error processing with Groq AI:', error);
    return "I'm having trouble processing your request right now. Please try again later.";
  }
}

/**
 * Generate a summary of a specific entity (property, unit, tenant)
 * @param {string} entityType - Type of entity (property, unit, tenant)
 * @param {Object} entityData - Entity data object
 * @returns {Promise<string>} Formatted summary with embedded images
 */
async function generateEntitySummary(entityType, entityData) {
  try {
    let prompt = `Generate a concise summary of this ${entityType} information. Format it nicely and include any image URLs as HTML img tags with class="thumbnail".`;
    
    // Add entity-specific details to prompt
    if (entityType === 'property') {
      prompt += ` Include name, address, type, and size.`;
    } else if (entityType === 'unit') {
      prompt += ` Include unitId, floor, rent, and availability status.`;
    } else if (entityType === 'tenant') {
      prompt += ` Include tenantId, name, contact info, unit, move-in date, and rent information.`;
    }
    
    // Add the entity data
    prompt += ` Here's the data: ${JSON.stringify(entityData)}`;
    
    // Using axios instead of groq-sdk for better Node.js 16 compatibility
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: "llama3-70b-8192",
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant that generates concise, well-formatted summaries of rental property information. Include images as HTML img tags."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.5,
        max_tokens: 1024,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Extract response content
    return response.data.choices[0].message.content || `Failed to generate ${entityType} summary.`;
  } catch (error) {
    console.error('Error generating entity summary with Groq:', error);
    return `Failed to generate ${entityType} summary.`;
  }
}

module.exports = {
  processWithGroq,
  generateEntitySummary
};
