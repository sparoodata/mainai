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
  // The subscription plan (e.g., "free", "premium", "enterprise")
  subscription: {
    type: String,
    default: 'free',
    enum: ['free', 'premium']
  },
  // When the current subscription became active
  subscriptionStart: { type: Date },
  // When the current subscription expires
  subscriptionEnd: { type: Date },
  // The date when the user registered
  registrationDate: {
    type: Date,
    default: Date.now
  },
  
age: Number,
country: String,
state: String,
newsletter: Boolean,
  // Role for access control (e.g., landlord, tenant, admin)
  role: { 
    type: String, 
    enum: ['landlord', 'tenant', 'admin'], 
    default: 'landlord'
  },
  // Additional fields such as address
  address: {
    street: { type: String },
    city: { type: String },
    state: { type: String },
    zipCode: { type: String },
    country: { type: String }
  },
  
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);