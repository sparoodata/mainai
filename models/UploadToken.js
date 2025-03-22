const mongoose = require('mongoose');

const UploadTokenSchema = new mongoose.Schema({
  token: {
    type: String,
    required: true,
    unique: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  purpose: {
    type: String,
    enum: ['property', 'unit', 'tenant', 'document'],
    required: true
  },
  relatedId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false
  },
  expiresAt: {
    type: Date,
    required: true,
    default: function() {
      // Default expiration: 1 hour from creation
      return new Date(Date.now() + 60 * 60 * 1000);
    }
  },
  used: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index to automatically expire tokens
UploadTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('UploadToken', UploadTokenSchema);
