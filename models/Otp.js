const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true },
    otp: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    lastAttempt: { type: Date },
    validated: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, expires: '5m' }, // OTP expires after 5 minutes
});

const Otp = mongoose.model('Otp', otpSchema);

module.exports = Otp;