const mongoose = require('mongoose');
const crypto = require('crypto');

// Authorize Schema
const authorizeSchema = new mongoose.Schema({
    _id: {
        type: String, // Override _id with String type
        required: true,
        default: () => crypto.randomBytes(32).toString('hex'), // Generate a 64-character ID
    },
    phoneNumber: String,
    status: {
        type: String,
        enum: ['Yes', 'No', 'Sent'],
        default: 'Sent',
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 3600, // Optional: Set expiry for authorization (e.g., 1 hour)
    },
});

module.exports = mongoose.model('Authorize', authorizeSchema);
