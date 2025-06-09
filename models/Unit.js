const mongoose = require('mongoose');

const unitSchema = new mongoose.Schema({
  unitId: { type: String, unique: true },
  property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
  unitNumber: { type: String, required: true },
  floor: { type: String },
  squareFootage: { type: Number },
  bedrooms: { type: Number },
  bathrooms: { type: Number },
  amenities: [String],
  rentAmount: { type: Number, required: true },
  securityDeposit: { type: Number },
  availabilityDate: { type: Date },
  leaseTerm: { type: String },
  status: { type: String, default: 'vacant' },
  images: [String],
  description: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('units', unitSchema);
