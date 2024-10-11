// models/Authorize.js
const mongoose = require('mongoose');

const authorizeSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true },
    status: { type: String, enum: ['Yes', 'No', 'Sent'], default: 'Sent' },
}, { timestamps: true });

module.exports = mongoose.model('Authorize', authorizeSchema);
