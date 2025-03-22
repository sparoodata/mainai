const mongoose = require('mongoose');

const TenantSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  contact: {
    email: {
      type: String,
      trim: true
    },
    phone: {
      type: String,
      trim: true
    }
  },
  unit: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Unit',
    required: true
  },
  moveInDate: {
    type: Date,
    required: true
  },
  rentInfo: {
    amount: Number,
    dueDate: {
      type: Number,
      min: 1,
      max: 31,
      default: 1
    },
    paymentHistory: [{
      date: Date,
      amount: Number,
      status: {
        type: String,
        enum: ['Paid', 'Pending', 'Late', 'Partial'],
        default: 'Pending'
      }
    }]
  },
  documents: [{
    url: String,
    filename: String,
    type: {
      type: String,
      enum: ['Lease', 'ID', 'Other'],
      default: 'Other'
    },
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

module.exports = mongoose.model('Tenant', TenantSchema);
