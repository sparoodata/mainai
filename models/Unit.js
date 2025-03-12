const mongoose = require('mongoose');

const unitSchema = new mongoose.Schema({
  unitNumber: { type: String, required: true },
  property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
  rentAmount: { type: Number, required: true },
  floor: { type: String },
  size: { type: String },
  images: [{ type: String }], // Array of bucket paths (e.g., ["images/1741474825521-HEIF Image.jpeg"])
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Unit', unitSchema);