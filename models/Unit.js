const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const unitSchema = new Schema({
    property: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
    unitNumber: { type: String, required: true },
    rentAmount: { type: Number, required: true },
    floor: { type: String },
    size: { type: Number },
    images: [{ type: String }], // Array of image URLs (e.g., from R2)
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Unit', unitSchema);