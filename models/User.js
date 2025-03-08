// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true,
    unique: true,
  },
  verified: {
    type: Boolean,
    default: false,
  },
  profileName: {
    type: String,
  },
  registrationDate: {
    type: Date,
    default: Date.now,
  },
  verifiedDate: {
    type: Date,
  },
  subscription: {
    type: String,
    enum: ['Free', 'Premium'], // Restrict values to 'Free' or 'Premium'
    default: 'Free', // Default to 'Free' for new users
  },
});

module.exports = mongoose.model('User', userSchema);