const mongoose = require('mongoose');

// Define Memory schema
const memorySchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  role: {
    type: String,
    enum: ['user', 'assistant'],
    required: true
  },
  content: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

// Create index for efficient retrieval
memorySchema.index({ userId: 1, timestamp: -1 });

// Create model
const Memory = mongoose.model('Memory', memorySchema);

/**
 * Initialize MongoDB memory system
 * @returns {Promise<boolean>} Success status
 */
async function initializeMongoMemory() {
  try {
    // Check if we're connected to MongoDB
    if (mongoose.connection.readyState !== 1) {
      console.error('MongoDB not connected');
      return false;
    }
    
    console.log('MongoDB memory system initialized successfully');
    return true;
  } catch (error) {
    console.error('Error initializing MongoDB memory:', error);
    return false;
  }
}

/**
 * Add memory to MongoDB
 * @param {string} userId - User identifier
 * @param {string} message - Message content
 * @param {string} role - Message role (user or assistant)
 * @returns {Promise<boolean>} Success status
 */
async function addMemory(userId, message, role = 'user') {
  try {
    // Create new memory document
    const memory = new Memory({
      userId,
      role,
      content: message,
      timestamp: new Date()
    });
    
    // Save to MongoDB
    await memory.save();
    
    return true;
  } catch (error) {
    console.error('Error adding memory to MongoDB:', error);
    return false;
  }
}

/**
 * Get memory from MongoDB
 * @param {string} userId - User identifier
 * @param {number} limit - Maximum number of memories to retrieve
 * @returns {Promise<Array>} Array of memories
 */
async function getMemory(userId, limit = 20) {
  try {
    // Get memories from MongoDB, sorted by timestamp (newest first)
    const memories = await Memory.find({ userId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
    
    // Return in reverse order (oldest first) for conversation flow
    return memories.reverse().map(memory => ({
      role: memory.role,
      content: memory.content
    }));
  } catch (error) {
    console.error('Error getting memory from MongoDB:', error);
    return [];
  }
}

/**
 * Search memory in MongoDB
 * @param {string} userId - User identifier
 * @param {string} query - Search query
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Array of search results
 */
async function searchMemory(userId, query, limit = 5) {
  try {
    // Search memories in MongoDB using text search
    const memories = await Memory.find({
      userId,
      content: { $regex: query, $options: 'i' } // Case-insensitive search
    })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
    
    return memories;
  } catch (error) {
    console.error('Error searching memory in MongoDB:', error);
    return [];
  }
}

module.exports = {
  initializeMongoMemory,
  addMemory,
  getMemory,
  searchMemory
};
