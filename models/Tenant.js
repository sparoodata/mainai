const mongoose = require('mongoose');

module.exports = mongoose.model('Tenant', new mongoose.Schema({
  propertyId: mongoose.Schema.Types.ObjectId,
  name: String,
  phone: String,
  rent: Number
}));
