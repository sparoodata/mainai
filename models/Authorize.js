const mongoose = require('mongoose');

const authorizeSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true },
    status: { type: String, default: 'Sent' },
    used: { type: Boolean, default: false }, // Add this field
}, { timestamps: true });

const Authorize = mongoose.model('Authorize', authorizeSchema);

module.exports = Authorize;
