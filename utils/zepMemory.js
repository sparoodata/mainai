const mongoose = require('mongoose');
const { ZepClient } = require('@getzep/zep-js');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Initialize Zep client
const zepClient = new ZepClient(process.env.ZEP_API_URL);

/**
 * Initialize Zep memory collection
 * @returns {Promise<boolean>} Success status
 */
const initializeZepMemory = async () => {
  try {
    // Check if collection exists
    let collection;
    try {
      collection = await zepClient.document.getCollection(process.env.ZEP_COLLECTION_NAME);
    } catch (error) {
      console.log('Collection does not exist yet, will create it');
    }
    
    // Create collection if it doesn't exist
    if (!collection) {
      await zepClient.document.addCollection({
        name: process.env.ZEP_COLLECTION_NAME,
        description: "Rental property management conversations",
        metadata: {
          application: "rental-bot"
        }
      });
      console.log(`Created Zep collection: ${process.env.ZEP_COLLECTION_NAME}`);
    } else {
      console.log(`Zep collection already exists: ${process.env.ZEP_COLLECTION_NAME}`);
    }
    
    return true;
  } catch (error) {
    console.error('Error initializing Zep memory:', error);
    return false;
  }
};

/**
 * Add memory to Zep collection
 * @param {string} userId - User identifier
 * @param {string} message - Message content
 * @param {boolean} isUser - Whether the message is from user (true) or assistant (false)
 * @returns {Promise<boolean>} Success status
 */
const addMemory = async (userId, message, isUser = true) => {
  try {
    await zepClient.memory.addMemory(
      process.env.ZEP_COLLECTION_NAME,
      userId,
      {
        role: isUser ? "user" : "assistant",
        content: message
      }
    );
    
    return true;
  } catch (error) {
    console.error('Error adding memory to Zep:', error);
    return false;
  }
};

/**
 * Get conversation history from Zep
 * @param {string} userId - User identifier
 * @param {number} limit - Maximum number of messages to retrieve
 * @returns {Promise<Array>} Conversation history
 */
const getMemory = async (userId, limit = 50) => {
  try {
    const history = await zepClient.memory.getMemory(
      process.env.ZEP_COLLECTION_NAME,
      userId,
      { limit }
    );
    
    return history || [];
  } catch (error) {
    console.error('Error retrieving memory from Zep:', error);
    return [];
  }
};

/**
 * Search memory for specific content
 * @param {string} userId - User identifier
 * @param {string} query - Search query
 * @returns {Promise<Array>} Search results
 */
const searchMemory = async (userId, query) => {
  try {
    const results = await zepClient.memory.searchMemory(
      process.env.ZEP_COLLECTION_NAME,
      userId,
      { text: query }
    );
    
    return results || [];
  } catch (error) {
    console.error('Error searching Zep memory:', error);
    return [];
  }
};

/**
 * Summarize conversation history
 * @param {string} userId - User identifier
 * @returns {Promise<string>} Conversation summary
 */
const summarizeMemory = async (userId) => {
  try {
    const summary = await zepClient.memory.summarizeMemory(
      process.env.ZEP_COLLECTION_NAME,
      userId
    );
    
    return summary?.summary || "No conversation summary available.";
  } catch (error) {
    console.error('Error summarizing Zep memory:', error);
    return "Failed to generate conversation summary.";
  }
};

module.exports = {
  initializeZepMemory,
  addMemory,
  getMemory,
  searchMemory,
  summarizeMemory
};
