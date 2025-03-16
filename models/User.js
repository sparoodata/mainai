const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // Unique phone number used as primary identifier (required)
  phoneNumber: { 
    type: String, 
    required: true, 
    unique: true,
    trim: true
  },
  // The user's display or profile name
  profileName: { 
    type: String, 
    default: '',
    trim: true
  },
  // Optional email address (could be used for notifications)
  email: { 
    type: String,
    trim: true,
    lowercase: true
  },
  // A flag indicating if the user has been verified
  verified: { 
    type: Boolean, 
    default: false 
  },
  // The subscription plan (e.g., "free", "premium")
  subscription: { 
    type: String, 
    default: 'free',
    enum: ['free', 'premium', 'enterprise']  // adjust as needed
  },
  // The date when the user registered
  registrationDate: { 
    type: Date, 
    default: Date.now 
  },
  // Role for access control (e.g., landlord, tenant, admin)
  role: { 
    type: String, 
    enum: ['landlord', 'tenant', 'admin'], 
    default: 'landlord'
  },
  // Additional fields such as address can be added here
  address: {
    street: { type: String },
    city: { type: String },
    state: { type: String },
    zipCode: { type: String },
    country: { type: String }
  },
  // Metadata (timestamps provided by schema options as well)
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
