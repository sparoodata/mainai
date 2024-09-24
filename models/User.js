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
  otpExpiration: {
    type: Date
  }
});

module.exports = mongoose.model('User', UserSchema);
