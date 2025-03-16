// routes/webhook.js
const express = require('express');
const router = express.Router();
const { handleWebhookEvent, sendMessage, sendSummary } = require('../controllers/webhookController');

// Example: handle inbound webhook
router.post('/', handleWebhookEvent);

// Export needed functions if other files need them 
module.exports = router;

// If you need to re-export sendMessage, sendSummary for other modules:
module.exports.sendMessage = sendMessage;
module.exports.sendSummary = sendSummary;
