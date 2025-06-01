// helpers/ai.js
const axios = require('axios');

const AI_URL = 'https://misty-hot-country.glitch.me/mcp';

/**
 * Send a natural-language query to the MCP AI service.
 * @param {string} message  The text AFTER the leading back-slash.
 * @returns {Promise<string>} The AI’s answer.
 */
async function askAI(message) {
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) throw new Error('MCP_API_KEY missing in .env');

  const { data } = await axios.post(
    AI_URL,
    { message },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-MCP-Key': apiKey,
      },
    },
  );

  // Adjust this line if the service returns a different shape.
  return data.reply || JSON.stringify(data);
}

module.exports = { askAI };
