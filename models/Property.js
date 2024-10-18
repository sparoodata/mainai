const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const propertySchema = new mongoose.Schema({
    name: String,
    units: Number,
    address: String,
    totalAmount: Number,
    images: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Image' }],
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }  // Reference to the User model
});

module.exports = mongoose.model('properties', propertySchema);
