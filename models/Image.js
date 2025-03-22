const mongoose = require('mongoose');

// Image Schema
const imageSchema = new mongoose.Schema({
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' }, // Reference to the Property
    imageUrl: String, // URL or path where the image is stored
    imageName: String,
    uploadedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Image', imageSchema);
