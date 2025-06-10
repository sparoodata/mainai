const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema({
  // A unique identifier (if needed, you can also use the default _id)
  propertyId: { type: String, unique: true },
  // Basic Info
  name: { type: String, required: true },
  description: { type: String },
  // Address details
  address: { type: String, required: true },
  city: { type: String },
  state: { type: String },
  zipCode: { type: String },
  country: { type: String },
  geoCoordinates: { type: [Number], index: '2dsphere' },
  // Additional details
  propertyType: { type: String },
  yearBuilt: { type: Number },
  totalUnits: { type: Number, required: true },
  availableUnits: { type: Number },
  amenities: [String],
  status: { type: String, default: 'active' },
  // Financial & contact info
  purchasePrice: { type: Number },
  marketValue: { type: Number },
  rentalIncome: { type: Number },
  managementContact: {
    name: String,
    phone: String,
    email: String,
  },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Media and other metadata
  images: [String],
  notes: { type: String },
}, { timestamps: true });

// Export as `Property` while ensuring the MongoDB collection is named `properties`
module.exports = mongoose.model('Property', propertySchema, 'properties');
