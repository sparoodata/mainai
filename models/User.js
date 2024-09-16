// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    phoneNumber: { type: String, unique: true, required: true },
    verified: { type: Boolean, default: false },
    otp: { type: String },
    otpExpiresAt: { type: Date },
    // Add other user fields as needed
});

module.exports = mongoose.model('User', userSchema);
