// routes/chat.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { buildMemoryForUser, callGroqApi } = require('../controllers/chatController');

router.post('/', async (req, res) => {
  const { phoneNumber, message } = req.body;
  if (!phoneNumber || !message) {
    return res.status(400).json({ error: 'phoneNumber and message are required.' });
  }

  try {
    // 1) Find user
    const user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).json({ error: 'No user found with that phone number.' });
    }

    // 2) Build memory
    const memoryContext = await buildMemoryForUser(user._id);

    // 3) Call GROQ
    const reply = await callGroqApi(memoryContext, message);

    return res.json({ reply });
  } catch (error) {
    console.error('Error in /chat:', error.message);
    let errMsg = 'Something went wrong. Please try again.';
    if (error.message.includes('429')) {
      errMsg = 'Rate limit exceeded. Try again in a moment.';
    } else if (error.message.includes('413')) {
      errMsg = 'Request too large. Please simplify your question.';
    }
    return res.status(500).json({ reply: errMsg });
  }
});

module.exports = router;
