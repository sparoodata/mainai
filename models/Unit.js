const mongoose = require('mongoose');

const UnitSchema = new mongoose.Schema({
  unitId: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  property: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property',
    required: true
  },
  floor: {
    type: String,
    required: true,
    trim: true
  },
  rent: {
    type: Number,
    required: true
  },
  isAvailable: {
    type: Boolean,
    default: true
  },
  images: [{
    url: String,
    filename: String,
    uploadDate: {
      type: Date,
      default: Date.now
    }
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Unit', UnitSchema);
