const mongoose = require('mongoose');

const UnitSchema = new mongoose.Schema({
  unit_id: { type: String, required: true, unique: true },
  property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
  unitNumber: { type: String, required: true },
  floor: { type: String },
  size: { type: String },
  rentAmount: { type: Number, required: true },
  deposit: { type: Number },
  status: { type: String, default: 'Vacant' },
  images: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Image' }],
  tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
  description: { type: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

module.exports = mongoose.model('Unit', UnitSchema);
