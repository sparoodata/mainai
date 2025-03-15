const mongoose = require('mongoose');

const TenantSchema = new mongoose.Schema({
  tenant_id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  email: { type: String },
  unitAssigned: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
  propertyName: { type: String, required: true },
  lease_start: { type: String, required: true },
  lease_end: { type: String },
  deposit: { type: Number, required: true },
  rent_amount: { type: Number, required: true },
  photo: { type: String },
  documents: [String],
  paymentHistory: [{ amount: Number, date: String, mode: String }],
  notes: { type: String },
  status: { type: String, default: 'Active' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

module.exports = mongoose.model('Tenant', TenantSchema);