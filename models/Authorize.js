const mongoose = require('mongoose');

const authorizeSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true },
    status: { type: String, required: true, default: 'Sent' }
});

const Authorize = mongoose.model('Authorize', authorizeSchema);

module.exports = Authorize;
