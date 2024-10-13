const mongoose = require('mongoose');

// Property Schema
const propertySchema = new mongoose.Schema({
    name: String,
    units: Number,
    address: String,
    totalAmount: Number,
    images: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Image' }] // Link to images collection
});

module.exports = mongoose.model('Property', propertySchema);
