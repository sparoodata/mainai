const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema({
    name: String,
    units: Number,
    address: String,
    totalAmount: Number,
    image: String
});

module.exports = mongoose.model('Property', propertySchema);
