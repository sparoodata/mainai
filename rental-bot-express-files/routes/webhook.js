const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { processWithGroq } = require('../utils/groqAI');
const { addMemory, getMemory } = require('../utils/mongoMemory');
const { uploadImageWithThumbnail } = require('../utils/helpers');
const BotConversationManager = require('../utils/botConversation');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage });

// Initialize bot conversation manager
const botManager = new BotConversationManager();

// Webhook endpoint for chat messages
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const { userId, message } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    // Handle file upload if present
    let fileInfo = null;
    if (req.file) {
      const filePath = path.join(__dirname, '..', req.file.path);
      const fileBuffer = fs.readFileSync(filePath);
      
      // Upload file to storage (e.g., Cloudflare R2)
      if (req.file.mimetype.startsWith('image/')) {
        fileInfo = await uploadImageWithThumbnail(fileBuffer, req.file.originalname, req.file.mimetype);
      } else {
        // Handle non-image files if needed
        // fileInfo = await uploadFile(fileBuffer, req.file.originalname, req.file.mimetype);
      }
      
      // Clean up temporary file
      fs.unlinkSync(filePath);
    }
    
    // Add user message to memory
    await addMemory(userId, message);
    
    // Get conversation history
    const history = await getMemory(userId);
    
    // Check if this is a bot command
    const botResponse = await botManager.handleMessage(userId, message, fileInfo);
    
    if (botResponse) {
      // Add bot response to memory
      await addMemory(userId, botResponse, 'assistant');
      
      return res.json({ response: botResponse });
    }
    
    // Process with Groq AI
    const response = await processWithGroq(userId, message, history);
    
    // Add AI response to memory
    await addMemory(userId, response, 'assistant');
    
    res.json({ response });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

module.exports = router;
