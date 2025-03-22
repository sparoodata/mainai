const { ZepClient } = require('@getzep/zep-js');

// Initialize Zep client with cloud API configuration
let zepClient = null;

/**
 * Initialize Zep memory system
 * @returns {Promise<boolean>} Success status
 */
async function initializeZepMemory() {
  try {
    // Initialize Zep client with cloud API
    zepClient = new ZepClient({
      apiUrl: process.env.ZEP_API_URL || 'https://api.getzep.com', // Cloud ZEP API URL
      apiKey: process.env.ZEP_API_KEY // Your cloud ZEP API key
    });
    
    // Collection name for conversations
    const collectionName = process.env.ZEP_COLLECTION_NAME || 'rental-bot-conversations';
    
    // Check if collection exists, create if not
    try {
      await zepClient.getCollection(collectionName);
      console.log(`ZEP collection '${collectionName}' exists`);
    } catch (error) {
      // Collection doesn't exist, create it
      console.log(`Creating ZEP collection '${collectionName}'...`);
      await zepClient.createCollection({
        name: collectionName,
        description: "Rental property management chatbot conversations",
        metadata: {
          application: "rental-property-management"
        }
      });
      console.log(`ZEP collection '${collectionName}' created successfully`);
    }
    
    return true;
  } catch (error) {
    console.error('Error initializing ZEP memory:', error);
    return false;
  }
}

/**
 * Add memory to Zep
 * @param {string} userId - User identifier
 * @param {string} message - Message content
 * @param {string} role - Message role (user or assistant)
 * @returns {Promise<boolean>} Success status
 */
async function addMemory(userId, message, role = 'user') {
  try {
    if (!zepClient) {
      console.error('ZEP client not initialized');
      return false;
    }
    
    const collectionName = process.env.ZEP_COLLECTION_NAME || 'rental-bot-conversations';
    
    // Add memory to Zep
    await zepClient.addMemory(collectionName, userId, [{
      role: role,
      content: message,
      metadata: {
        timestamp: new Date().toISOString()
      }
    }]);
    
    return true;
  } catch (error) {
    console.error('Error adding memory to ZEP:', error);
    return false;
  }
}

/**
 * Get memory from Zep
 * @param {string} userId - User identifier
 * @param {number} limit - Maximum number of memories to retrieve
 * @returns {Promise<Array>} Array of memories
 */
async function getMemory(userId, limit = 20) {
  try {
    if (!zepClient) {
      console.error('ZEP client not initialized');
      return [];
    }
    
    const collectionName = process.env.ZEP_COLLECTION_NAME || 'rental-bot-conversations';
    
    // Get memory from Zep
    const memories = await zepClient.getMemory(collectionName, userId, { limit });
    
    // Format memories for use with Groq
    return memories.map(memory => ({
      role: memory.role,
      content: memory.content
    }));
  } catch (error) {
    console.error('Error getting memory from ZEP:', error);
    return [];
  }
}

/**
 * Search memory in Zep
 * @param {string} userId - User identifier
 * @param {string} query - Search query
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Array of search results
 */
async function searchMemory(userId, query, limit = 5) {
  try {
    if (!zepClient) {
      console.error('ZEP client not initialized');
      return [];
    }
    
    const collectionName = process.env.ZEP_COLLECTION_NAME || 'rental-bot-conversations';
    
    // Search memory in Zep
    const results = await zepClient.searchMemory(collectionName, userId, query, { limit });
    
    return results;
  } catch (error) {
    console.error('Error searching memory in ZEP:', error);
    return [];
  }
}

module.exports = {
  initializeZepMemory,
  addMemory,
  getMemory,
  searchMemory
};
