// webhook.js
const express = require('express');
const axios = require('axios');
const User = require('../models/User');       // Assuming you have a User model
const Tenant = require('../models/Tenant');   // Assuming you have a Tenant model
const Authorize = require('../models/Authorize'); // Assuming you have an Authorize model

const router = express.Router();

// WhatsApp API credentials
const WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0/110765315459068/messages';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const GLITCH_HOST = process.env.GLITCH_HOST; // Your Glitch project URL

// Session management to track user interactions
const sessions = {};      // e.g., { "918885305097": { action: "rent_paid" } }
let userResponses = {};   // e.g., { "918885305097": "Yes_authorize" }

// Helper function to shorten URLs
async function shortenUrl(longUrl) {
  try {
    const response = await axios.post('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl));
    return response.data;
  } catch (error) {
    console.error('Error shortening URL:', error.response ? error.response.data : error);
    return longUrl; // Fallback to long URL if shortener fails
  }
}

// Webhook verification for WhatsApp API
router.get('/', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified successfully');
      return res.status(200).send(challenge);
    } else {
      console.error('Webhook verification failed');
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// Webhook event handling
router.post('/', async (req, res) => {
  const body = req.body;

  // Check if this is an event from WhatsApp Business API
  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry[0];
    const changes = entry.changes[0];
    const value = changes.value;

    // Handle contacts to capture profile name
    if (value.contacts) {
      const contact = value.contacts[0];
      const contactPhoneNumber = `+${contact.wa_id}`;
      const profileName = contact.profile.name;
      console.log(`Profile name received: ${profileName} for phone number: ${contactPhoneNumber}`);

      // Find the user by phone number and update profile name if available
      const user = await User.findOne({ phoneNumber: contactPhoneNumber });
      if (user) {
        if (profileName) {
          user.profileName = profileName;
          await user.save();
          console.log(`Profile name updated to ${profileName} for user ${contactPhoneNumber}`);
        } else {
          console.log(`No profile name available to update for user ${contactPhoneNumber}`);
        }
      } else {
        console.log(`No user found for phone: ${contactPhoneNumber}`);
      }
    }

    if (value.messages) {
      const message = value.messages[0];
      const fromNumber = message.from;         // e.g., "918885305097"
      const phoneNumber = `+${fromNumber}`;      // e.g., "+918885305097"
      const text = message.text ? message.text.body.trim() : null;
      const interactive = message.interactive || null;

      // Handle interactive button reply
      if (interactive && interactive.type === 'button_reply') {
        const buttonReplyId = interactive.button_reply.id; // e.g., 'Yes_authorize', 'rent_paid'
        console.log(`Button reply received: ${buttonReplyId} from ${fromNumber}`);

        // Store the response for later use
        userResponses[fromNumber] = buttonReplyId;
      }

      // Initialize session for this number if it doesn't exist
      if (!sessions[fromNumber]) {
        sessions[fromNumber] = { action: null };
      }

      // Log the received message
      console.log(`Received message from ${phoneNumber}: ${text}`);

      // Handle "help" message (case-insensitive)
      if (text && text.toLowerCase() === 'help') {
        try {
          sessions[fromNumber].action = null; // reset any pending action

          // Send WhatsApp button menu
          const buttonMenu = {
            messaging_product: 'whatsapp',
            to: fromNumber,
            type: 'interactive',
            interactive: {
              type: 'button',
              header: { type: 'text', text: 'Choose an Option' },
              body: { text: 'Please select an option below:' },
              footer: { text: 'Powered by your rental app' },
              action: {
                buttons: [
                  { type: 'reply', reply: { id: 'account_info', title: 'Account Info' } },
                  { type: 'reply', reply: { id: 'manage', title: 'Manage' } },
                  { type: 'reply', reply: { id: 'transactions', title: 'Transactions' } }
                ]
              }
            }
          };

          await axios.post(WHATSAPP_API_URL, buttonMenu, {
            headers: {
              'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            }
          });

          console.log('Button menu sent to:', fromNumber);
        } catch (error) {
          console.error('Error sending button menu:', error.response ? error.response.data : error);
        }
      }
      // Handle other interactive message responses
      else if (interactive) {
        const selectedOption = interactive.button_reply.id; // Payload value
        // Process selected options
        if (selectedOption === 'account_info') {
          try {
            const user = await User.findOne({ phoneNumber });
            if (user) {
              const accountInfoMessage = `
*Account Info*:
- Phone Number: ${user.phoneNumber}
- Verified: ${user.verified ? 'Yes' : 'No'}
- Profile Name: ${user.profileName || 'N/A'}
- Registration Date: ${user.registrationDate ? user.registrationDate.toLocaleString() : 'N/A'}
- Verified Date: ${user.verifiedDate ? user.verifiedDate.toLocaleString() : 'N/A'}
              `;
              await axios.post(WHATSAPP_API_URL, {
                messaging_product: 'whatsapp',
                to: fromNumber,
                type: 'text',
                text: { body: accountInfoMessage }
              }, {
                headers: {
                  'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                  'Content-Type': 'application/json'
                }
              });
              console.log('Account info sent to:', phoneNumber);
            } else {
              await axios.post(WHATSAPP_API_URL, {
                messaging_product: 'whatsapp',
                to: fromNumber,
                type: 'text',
                text: { body: 'No account information found for this number.' }
              }, {
                headers: {
                  'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                  'Content-Type': 'application/json'
                }
              });
              console.log('No account information found for:', phoneNumber);
            }
          } catch (error) {
            console.error('Error fetching account info:', error.response ? error.response.data : error);
          }
        }
        // Handle 'Rent Paid' option: Ask for Tenant ID
        else if (selectedOption === 'rent_paid') {
          sessions[fromNumber].action = 'rent_paid';
          await sendMessage(fromNumber, 'Please provide the Tenant ID to confirm rent payment.');
        }
        // Handle other menu options (Manage, Transactions, etc.)
        else if (selectedOption === 'manage') {
          await sendManageSubmenu(fromNumber);
        } else if (selectedOption === 'manage_properties') {
          await sendPropertyOptions(fromNumber);
        } else if (selectedOption === 'manage_units') {
          await sendUnitOptions(fromNumber);
        } else if (selectedOption === 'manage_tenants') {
          await sendTenantOptions(fromNumber);
        } else if (selectedOption === 'add_property') {
          await sendPropertyLink(fromNumber, 'addproperty');
        } else if (selectedOption === 'edit_property') {
          await sendPropertyLink(fromNumber, 'editproperty');
        } else if (selectedOption === 'remove_property') {
          await sendPropertyLink(fromNumber, 'removeproperty');
        } else if (selectedOption === 'add_unit') {
          await sendPropertyLink(fromNumber, 'addunit');
        } else if (selectedOption === 'edit_unit') {
          await sendPropertyLink(fromNumber, 'editunit');
        } else if (selectedOption === 'remove_unit') {
          await sendPropertyLink(fromNumber, 'removeunit');
        } else if (selectedOption === 'add_tenant') {
          await sendPropertyLink(fromNumber, 'addtenant');
        } else if (selectedOption === 'edit_tenant') {
          await sendPropertyLink(fromNumber, 'edittenant');
        } else if (selectedOption === 'remove_tenant') {
          await sendPropertyLink(fromNumber, 'removetenant');
        }
      }
      // Handle text input when expecting tenant ID for rent payment
      else if (sessions[fromNumber].action === 'rent_paid' && text) {
        const tenantId = text.trim();
        try {
          const tenant = await Tenant.findOne({ tenant_id: tenantId });
          if (tenant) {
            tenant.status = 'paid'; // update status to 'paid'
            await tenant.save();
            await sendMessage(fromNumber, `Rent payment confirmed for Tenant ID: ${tenantId}.`);
            console.log(`Tenant rent status updated to paid for Tenant ID: ${tenantId}`);
            sessions[fromNumber].action = null; // reset session action
          } else {
            await sendMessage(fromNumber, `Tenant with ID "${tenantId}" not found.`);
          }
        } catch (error) {
          console.error('Error updating rent status:', error);
          await sendMessage(fromNumber, 'Failed to confirm rent payment. Please try again.');
        }
      } else {
        console.log(`Session action: ${sessions[fromNumber].action}`);
        console.log('Received non-interactive message or invalid interaction.');
      }
    }
  } else {
    return res.sendStatus(404);
  }

  // Respond to WhatsApp API with success
  res.sendStatus(200);
});

// Helper function to send a WhatsApp message
async function sendMessage(phoneNumber, message) {
  try {
    await axios.post(WHATSAPP_API_URL, {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'text',
      text: { body: message }
    }, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('Error sending WhatsApp message:', err.response ? err.response.data : err);
  }
}

// Helper function to wait for the user response (polling every second)
async function waitForUserResponse(phoneNumber, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const intervalId = setInterval(() => {
            if (userResponses[phoneNumber]) {
                const response = userResponses[phoneNumber];
                clearInterval(intervalId);
                console.log(`Captured user response: ${response} from ${phoneNumber}`);
                delete userResponses[phoneNumber]; // Clear the response after use
                resolve(response);
            } else if (Date.now() - startTime >= timeout) {
                clearInterval(intervalId);
                console.error(`Authorization timed out for ${phoneNumber}`);
                reject(new Error('Authorization timed out.'));
            }
        }, 500); // Poll every 500ms
    });
}
// Helper function to send the manage submenu
async function sendManageSubmenu(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Manage Options' },
      body: { text: 'Please select an option below:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'manage_properties', title: 'Manage Properties' } },
          { type: 'reply', reply: { id: 'manage_units', title: 'Manage Units' } },
          { type: 'reply', reply: { id: 'manage_tenants', title: 'Manage Tenants' } }
        ]
      }
    }
  };

  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// Helper function for Property Options (Add, Edit, Remove)
async function sendPropertyOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Property Options' },
      body: { text: 'Please select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_property', title: 'Add Property' } },
          { type: 'reply', reply: { id: 'edit_property', title: 'Edit Property' } },
          { type: 'reply', reply: { id: 'remove_property', title: 'Remove Property' } }
        ]
      }
    }
  };

  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// Helper function for Unit Options (Add, Edit, Remove)
async function sendUnitOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Unit Options' },
      body: { text: 'Please select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_unit', title: 'Add Unit' } },
          { type: 'reply', reply: { id: 'edit_unit', title: 'Edit Unit' } },
          { type: 'reply', reply: { id: 'remove_unit', title: 'Remove Unit' } }
        ]
      }
    }
  };

  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// Helper function for Tenant Options (Add, Edit, Remove)
async function sendTenantOptions(phoneNumber) {
  const buttonMenu = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Tenant Options' },
      body: { text: 'Please select an option:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'add_tenant', title: 'Add Tenant' } },
          { type: 'reply', reply: { id: 'edit_tenant', title: 'Edit Tenant' } },
          { type: 'reply', reply: { id: 'remove_tenant', title: 'Remove Tenant' } }
        ]
      }
    }
  };

  await axios.post(WHATSAPP_API_URL, buttonMenu, {
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}



async function sendPropertyLink(phoneNumber, action) {
  console.log(`sendPropertyLink called for phoneNumber: ${phoneNumber}, action: ${action}`); // Debug log

  try {
    // Log the phone number being queried
    console.log(`Querying Authorize collection for phoneNumber: +${phoneNumber}`);

    // Find or create the document in the 'authorizes' collection based on the phone number
    let authorizeRecord = await Authorize.findOne({ phoneNumber: `+${phoneNumber}` });

    if (!authorizeRecord) {
      // If no record exists, create a new one
      authorizeRecord = new Authorize({
        phoneNumber: `+${phoneNumber}`,
        used: false, // Mark as unused initially
        createdAt: new Date(),
      });
      await authorizeRecord.save();
      console.log(`New authorization record created with ID: ${authorizeRecord._id}`); // Debug log
    } else {
      console.log(`Existing authorization record found with ID: ${authorizeRecord._id}`); // Debug log
    }

    // Construct the long URL for OTP verification
    const longUrl = `${GLITCH_HOST}/authorize/${authorizeRecord._id}`;
    console.log(`Long URL generated: ${longUrl}`); // Debug log

    // Shorten the URL
    const shortUrl = await shortenUrl(longUrl);
    console.log(`Short URL generated: ${shortUrl}`); // Debug log

    // Send the OTP verification link to the user
    await sendMessage(phoneNumber, `Proceed: ${shortUrl}`);
    console.log(`OTP verification link sent to ${phoneNumber}`); // Debug log
  } catch (error) {
    console.error('Error in sendPropertyLink:', error); // Debug log
    await sendMessage(phoneNumber, 'Failed to retrieve authorization record. Please try again.');
  }
}

// Export the sendMessage function
module.exports = {
  router,
  waitForUserResponse,
  userResponses,
  sessions,
  sendMessage, // Add this line
};