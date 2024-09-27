const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true,
    unique: true
  },
  verified: {
    type: Boolean,
    default: false
  },
  otp: {
    type: String
  },
  otpExpiresAt: { // Change to otpExpiresAt to match your route logic
    type: Date
  }
});

module.exports = mongoose.model('User', UserSchema);
