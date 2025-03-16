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
  // The subscription plan (e.g., "Free", "Premium", "Enterprise")
  subscription: { 
    type: String, 
    default: 'Free',
    enum: ['Free', 'Premium', 'Enterprise']
  },
  // The date when the user registered
  registrationDate: { 
    type: Date, 
    default: Date.now 
  },
  // Role for access control (e.g., landlord, tenant, admin)
  role: { 
    type: String, 
    enum: ['Landlord', 'Tenant', 'Admin'], 
    default: 'Landlord'
  },
  // Additional fields such as address
  address: {
    street: { type: String },
    city: { type: String },
    state: { type: String },
    zipCode: { type: String },
    country: { type: String }
  },
  // You can add more fields (e.g., password hash, settings, etc.) as needed
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
