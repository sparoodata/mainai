const axios = require('axios');
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

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
  try {
    await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'text',
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('Error sending WhatsApp message:', err.response ? err.response.data : err);
  }
}

async function sendImageMessage(phoneNumber, imageUrl, caption) {
  try {
    const response = await axios.post(
      WHATSAPP_API_URL,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        type: 'image',
        image: {
          link: imageUrl,
          caption: caption,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('Image message sent:', response.data);
  } catch (err) {
    console.error('Error sending WhatsApp image message:', err.response ? err.response.data : err);
    // Fallback: Send a text message with the caption
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
  try {
    await axios.post(WHATSAPP_API_URL, buttonMenu, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('Error sending image option:', err.response ? err.response.data : err);
  }
}

module.exports = {
  shortenUrl,
  sendMessage,
  sendImageMessage,
  sendImageOption,
};
