const redis = require('redis');
const { promisify } = require('util');

// Initialize Redis client
let redisClient = null;
let getAsync = null;
let setAsync = null;
let keysAsync = null;

/**
 * Initialize Redis memory system
 * @returns {Promise<boolean>} Success status
 */
async function initializeRedisMemory() {
  try {
    // Create Redis client
    redisClient = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      password: process.env.REDIS_PASSWORD || undefined
    });

    // Promisify Redis commands
    getAsync = promisify(redisClient.get).bind(redisClient);
    setAsync = promisify(redisClient.set).bind(redisClient);
    keysAsync = promisify(redisClient.keys).bind(redisClient);

    // Handle Redis connection events
    redisClient.on('error', (err) => {
      console.error('Redis error:', err);
    });

    redisClient.on('connect', () => {
      console.log('Connected to Redis successfully');
    });

    return true;
  } catch (error) {
    console.error('Error initializing Redis memory:', error);
    return false;
  }
}

/**
 * Add memory to Redis
 * @param {string} userId - User identifier
 * @param {string} message - Message content
 * @param {string} role - Message role (user or assistant)
 * @returns {Promise<boolean>} Success status
 */
async function addMemory(userId, message, role = 'user') {
  try {
    if (!redisClient) {
      console.error('Redis client not initialized');
      return false;
    }
    
    // Get existing memories
    const existingMemoriesJson = await getAsync(`memories:${userId}`);
    let memories = [];
    
    if (existingMemoriesJson) {
      memories = JSON.parse(existingMemoriesJson);
    }
    
    // Add new memory
    memories.push({
      role,
      content: message,
      timestamp: new Date().toISOString()
    });
    
    // Limit memory size to last 50 messages to prevent excessive storage
    if (memories.length > 50) {
      memories = memories.slice(memories.length - 50);
    }
    
    // Save updated memories
    await setAsync(`memories:${userId}`, JSON.stringify(memories));
    
    return true;
  } catch (error) {
    console.error('Error adding memory to Redis:', error);
    return false;
  }
}

/**
 * Get memory from Redis
 * @param {string} userId - User identifier
 * @param {number} limit - Maximum number of memories to retrieve
 * @returns {Promise<Array>} Array of memories
 */
async function getMemory(userId, limit = 20) {
  try {
    if (!redisClient) {
      console.error('Redis client not initialized');
      return [];
    }
    
    // Get memories from Redis
    const memoriesJson = await getAsync(`memories:${userId}`);
    
    if (!memoriesJson) {
      return [];
    }
    
    // Parse memories
    const memories = JSON.parse(memoriesJson);
    
    // Return limited number of memories, most recent first
    return memories.slice(-limit).map(memory => ({
      role: memory.role,
      content: memory.content
    }));
  } catch (error) {
    console.error('Error getting memory from Redis:', error);
    return [];
  }
}

/**
 * Search memory in Redis (basic implementation)
 * @param {string} userId - User identifier
 * @param {string} query - Search query
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Array of search results
 */
async function searchMemory(userId, query, limit = 5) {
  try {
    if (!redisClient) {
      console.error('Redis client not initialized');
      return [];
    }
    
    // Get memories from Redis
    const memoriesJson = await getAsync(`memories:${userId}`);
    
    if (!memoriesJson) {
      return [];
    }
    
    // Parse memories
    const memories = JSON.parse(memoriesJson);
    
    // Simple search implementation (case-insensitive substring match)
    const queryLower = query.toLowerCase();
    const results = memories.filter(memory => 
      memory.content.toLowerCase().includes(queryLower)
    ).slice(0, limit);
    
    return results;
  } catch (error) {
    console.error('Error searching memory in Redis:', error);
    return [];
  }
}

/**
 * Close Redis connection
 * @returns {Promise<boolean>} Success status
 */
async function closeRedisConnection() {
  try {
    if (redisClient) {
      await promisify(redisClient.quit).bind(redisClient)();
      console.log('Redis connection closed');
    }
    return true;
  } catch (error) {
    console.error('Error closing Redis connection:', error);
    return false;
  }
}

module.exports = {
  initializeRedisMemory,
  addMemory,
  getMemory,
  searchMemory,
  closeRedisConnection
};
