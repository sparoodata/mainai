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
    profileName: {  // Ensure this field is present
        type: String
    },
    registrationDate: {
        type: Date,
        default: Date.now
    },
    verifiedDate: {
        type: Date
    }
});

module.exports = mongoose.model('User', UserSchema);
