const mongoose = require('mongoose');

const PropertySchema = new mongoose.Schema({
  property_id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  address: { type: String, required: true },
  city: { type: String, required: true },
  state: { type: String, required: true },
  zipcode: { type: String, required: true },
  country: { type: String, required: true },
  units: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Unit' }],
  totalAmount: { type: Number },
  images: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Image' }],
  description: { type: String },
  owner_name: { type: String },
  owner_contact: { type: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

module.exports = mongoose.model('Property', PropertySchema);
