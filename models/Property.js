const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema({
  name: { type: String, required: true },
  units: { type: Number, required: true },
  address: { type: String, required: true },
  totalAmount: { type: Number, required: true },
  images: [{ type: String }], // Array of bucket paths
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Property', propertySchema);