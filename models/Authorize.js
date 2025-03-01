const mongoose = require('mongoose');

const authorizeSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true,
    unique: true, // Ensure phone numbers are unique
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Authorize', authorizeSchema);