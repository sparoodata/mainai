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
  otpExpiresAt: {
    type: Date
  },
  profileName: { // New field to store the user's profile name
    type: String
  },
  registrationDate: { // Store the registration date
    type: Date,
    default: Date.now
  },
  verifiedDate: { // Store the date the user was verified
    type: Date
  }
});

module.exports = mongoose.model('User', UserSchema);
