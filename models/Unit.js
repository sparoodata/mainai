const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const unitSchema = new Schema({
    property: { type: Schema.Types.ObjectId, ref: 'Property', required: true }, // Reference to Property
    unitNumber: { type: String, required: true },
    rentAmount: { type: Number, required: true },
    floor: { type: Number, required: true },
    size: { type: Number, required: true },
    images: [{ type: Schema.Types.ObjectId, ref: 'Image' }] // Images linked to the unit
});

module.exports = mongoose.model('Unit', unitSchema);
