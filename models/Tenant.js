const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
  tenantId: { type: String, unique: true },
  fullName: { type: String, required: true },
  email: { type: String },
  phoneNumber: { type: String, required: true },
  currentAddress: { type: String },
  unitAssigned: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
  leaseStartDate: { type: Date, required: true },
  leaseEndDate: { type: Date },
  monthlyRent: { type: Number, required: true },
  depositAmount: { type: Number, required: true },
  leaseAgreement: { type: String }, // e.g., a URL reference
  employmentInformation: { type: String },
  creditScore: { type: Number },
  screeningResults: { type: String },
  // You can later add a subdocument or reference for payment history
  paymentHistory: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Payment' }],
  emergencyContact: {
    name: String,
    phone: String,
    relationship: String,
  },
  notes: { type: String },
  status: { type: String, default: 'active' },
}, { timestamps: true });

module.exports = mongoose.model('Tenant', tenantSchema);
