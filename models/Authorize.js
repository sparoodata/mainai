// models/Authorize.js
const mongoose = require('mongoose');

const authorizeSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true },
  used: { type: Boolean, default: false },
  action: { type: String }, // Add this field to store the action (e.g., 'addproperty', 'editproperty')
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Authorize', authorizeSchema);