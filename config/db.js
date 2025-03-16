// config/db.js
const mongoose = require('mongoose');

module.exports = async function connectDB() {
  try {
    mongoose.set('strictQuery', false); 
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};
