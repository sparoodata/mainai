const mongoose = require('mongoose');

const uploadTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  phoneNumber: { type: String, required: true },
  type: { type: String, enum: ['property', 'unit', 'tenant'], required: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
  used: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true, index: { expires: '0s' } }, // Auto-delete after expiration
});

module.exports = mongoose.model('UploadToken', uploadTokenSchema);