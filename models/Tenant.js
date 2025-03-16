const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  unitAssigned: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit' },
  propertyName: { type: String, required: true },
  lease_start: { type: Date },
  deposit: { type: Number, required: true },
  rent_amount: { type: Number, required: true },
  tenant_id: { type: String, required: true },
  email: { type: String },
  images: [{ type: String }], // Array of bucket paths for tenant photos
  idProof: { type: String }, // Optional: Could also be a bucket path if needed
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Tenant', tenantSchema);