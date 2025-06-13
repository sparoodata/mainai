const axios = require('axios');
const https = require('https');

const WHATSAPP_API_URL =
  'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const agent = new https.Agent({ keepAlive: true });

const api = axios.create({
  baseURL: WHATSAPP_API_URL,
  headers: {
    Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
  httpsAgent: agent,
  timeout: 10000,
});

async function sendRequest(payload, attempt = 1) {
  try {
    await api.post('', payload);
  } catch (err) {
    if (attempt < 3) return sendRequest(payload, attempt + 1);
    console.error('WhatsApp API error:', err.response ? err.response.data : err);
    throw err;
  }
}

async function shortenUrl(longUrl) {
  try {
    // TinyURL provides a simple GET API for shortening links
    // Use GET instead of POST to avoid unnecessary request body
    const response = await axios.get(
      'https://tinyurl.com/api-create.php',
      { params: { url: longUrl } }
    );
    return response.data;
  } catch (error) {
    console.error('Error shortening URL:', error);
    return longUrl;
  }
}

async function sendMessage(phoneNumber, message) {
  await sendRequest({
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'text',
    text: { body: message },
  });
}

async function sendImageMessage(phoneNumber, imageUrl, caption) {
  try {
    await sendRequest({
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'image',
      image: { link: imageUrl, caption },
    });
  } catch (err) {
    await sendMessage(phoneNumber, caption);
  }
}

async function sendImageOption(phoneNumber, type, entityId) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: {
        type: 'text',
        text: `📸 Add Image to ${type.charAt(0).toUpperCase() + type.slice(1)}`,
      },
      body: { text: `Would you like to upload an image for this ${type}?` },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: `upload_${type}_${entityId}`, title: 'Yes' },
          },
          {
            type: 'reply',
            reply: { id: `no_upload_${type}_${entityId}`, title: 'No' },
          },
        ],
      },
    },
  };
  await sendRequest(buttonMenu);
}

module.exports = {
  shortenUrl,
  sendMessage,
  sendImageMessage,
  sendImageOption,
  api,
};
