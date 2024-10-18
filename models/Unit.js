const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const unitSchema = new mongoose.Schema({
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
    unitNumber: String,
    rentAmount: Number,
    floor: String,
    size: String,
    images: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Image' }],
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }  // Reference to the User model
});

module.exports = mongoose.model('units', unitSchema);
