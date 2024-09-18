const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
    name: String,
    phoneNumber: String,
    idProof: String,
    photo: String,
    propertyName: String,
    unitAssigned: String,
    status: { type: String, default: 'unpaid' },
    apartment_id: mongoose.Schema.Types.ObjectId,
    unit: String,
    lease_start: Date,
    deposit: Number,
    rent_amount: Number,
    tenant_id: String
});

module.exports = mongoose.model('Tenant', tenantSchema);
