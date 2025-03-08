const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const propertySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  address: { type: String, required: true },
  description: String,
  imageUrl: String, // Add this
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Property', propertySchema);


