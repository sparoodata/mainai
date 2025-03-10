const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const propertySchema = new Schema({
    name: { type: String, required: true },
    units: { type: Number, required: true },
    address: { type: String, required: true },
    totalAmount: { type: Number, required: true },
    images: [{ type: Schema.Types.ObjectId, ref: 'Image' }],
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true } // Reference to User
});

module.exports = mongoose.model('Property', propertySchema);


