const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const tenantSchema = new Schema({
    name: { type: String, required: true },
    phoneNumber: { type: String, required: true }, // Tenant's phone number
    propertyName: { type: String, required: true }, // For simplicity, storing the name of the property
    unitAssigned: { type: Schema.Types.ObjectId, ref: 'Unit', required: true }, // Reference to Unit
    lease_start: { type: Date, required: true },
    deposit: { type: Number, required: true },
    rent_amount: { type: Number, required: true },
    tenant_id: { type: String, required: true },
    photo: { type: String }, // URL to photo stored in Dropbox
    idProof: { type: String }, // URL to ID proof stored in Dropbox
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true } // Reference to User
});

module.exports = mongoose.model('Tenant', tenantSchema);
