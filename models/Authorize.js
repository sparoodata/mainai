const mongoose = require('mongoose');

const authorizeSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true },
    status: { type: String, default: 'Sent' },
    used: { type: Boolean, default: false },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 10 * 60 * 1000) }, // 10 minutes from now
}, { timestamps: true });

const Authorize = mongoose.model('Authorize', authorizeSchema);

module.exports = Authorize;
