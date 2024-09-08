const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
    name: String,
    phoneNumber: String,
    idProof: String,
    photo: String,
    propertyName: String,
    unitAssigned: String,
    status: { type: String, default: 'unpaid' }
});

module.exports = mongoose.model('Tenant', tenantSchema);
