const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const propertySchema = new Schema({
    name: { type: String, required: true },
    units: { type: Number, required: true },
    address: { type: String, required: true },
    totalAmount: { type: Number, required: true },
    images: [{ type: String }], // Array of image URLs (e.g., from R2)
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now },
    __v: { type: Number },
});

module.exports = mongoose.model('Property', propertySchema);