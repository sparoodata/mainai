const mongoose = require('mongoose');

module.exports = mongoose.model('Account', new mongoose.Schema({
  whatsappNumber: { type: String, unique: true },
  email: String,
  age: Number,
  country: String,
  state: String,
  newsletter: Boolean,
  subscriptionType: { type: String, default: 'free' },
  propertiesLimit: { type: Number, default: 1 },
  tenantsLimit: { type: Number, default: 5 }
}));
