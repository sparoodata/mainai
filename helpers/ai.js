// helpers/ai.js
const axios = require('axios');

// Endpoint for the AI service.
// The server expects POST requests with a JSON body containing { prompt } and
// requires authentication via the `X-API-KEY` header.
// Update this URL if the service location changes.
const MCP_URL = 'https://getai-sooty.vercel.app/prompt';

/**
 * Ask the MCP AI a natural-language database query.
 * @param {string} message
 * @returns {Promise<string>}
 */
async function askAI(message) {
  const apiKey = process.env.MCP_API_KEY;
  console.log(apiKey);
  console.log(MCP_URL);
  if (!apiKey) throw new Error('MCP_API_KEY missing');

  // The service expects a JSON payload with a `prompt` field
  const payload = JSON.stringify({ prompt: message });
  
  // Use the API key via `X-API-KEY` header as required by the service
  const { data } = await axios.post(MCP_URL, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
  });
 console.log(data);
  // assume text reply
  return typeof data === 'string' ? data : JSON.stringify(data);
}

module.exports = { askAI };
