const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  razorpayPaymentId: { type: String, required: true, unique: true },
  amount: Number,
  currency: String,
  status: String,
  method: String,
  captured: Boolean,
  contact: String,
  email: String,
  fee: Number,
  tax: Number,
  description: String,
  paymentCreatedAt: Date,
  raw: { type: Object },
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);
