const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const tenantSchema = new Schema({
    name: { type: String, required: true },
    phoneNumber: { type: String, required: true },
    propertyName: { type: String, required: true },
    unitAssigned: { type: Schema.Types.ObjectId, ref: 'Unit', required: true },
    lease_start: { type: Date, required: true },
    deposit: { type: Number, required: true },
    rent_amount: { type: Number, required: true },
    tenant_id: { type: String, required: true },
    photo: { type: String }, // URL to photo stored in R2
    idProof: { type: String }, // URL to ID proof stored in R2
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, unique: true, sparse: true },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Tenant', tenantSchema);