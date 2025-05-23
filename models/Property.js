const mongoose = require('mongoose');

module.exports = mongoose.model('Property', new mongoose.Schema({
  ownerPhone: String,
  name: String,
  address: String
}));
