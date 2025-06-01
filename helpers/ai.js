// helpers/ai.js
const axios = require('axios');

const MCP_URL = 'https://misty-hot-country.glitch.me/mcp';

/**
 * Ask the MCP AI a natural-language database query.
 * @param {string} message
 * @returns {Promise<string>}
 */
async function askAI(message) {
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) throw new Error('MCP_API_KEY missing');

  const payload = JSON.stringify({ message });

  const { data } = await axios.post(MCP_URL, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-MCP-Key': apiKey,
    },
  });

  // assume text reply
  return typeof data === 'string' ? data : JSON.stringify(data);
}

module.exports = { askAI };
