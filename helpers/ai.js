// helpers/ai.js
const axios = require('axios');

// Endpoint for the AI service. Previously this pointed to our MCP instance
// but has been updated to use the new NPIK service.
const MCP_URL = 'https://getai-npik.onrender.com/prompt';

/**
 * Ask the MCP AI a natural-language database query.
 * @param {string} message
 * @returns {Promise<string>}
 */
async function askAI(message) {
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) throw new Error('MCP_API_KEY missing');

  // The NPIK API expects a JSON payload with a `prompt` field
  const payload = JSON.stringify({ prompt: message });

  // Use the API key via `X-API-KEY` header as required by the service
  const { data } = await axios.post(MCP_URL, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
  });

  // assume text reply
  return typeof data === 'string' ? data : JSON.stringify(data);
}

module.exports = { askAI };
