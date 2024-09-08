const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();

app.use(bodyParser.json());
app.use(express.static('public'));

// Connect to MongoDB
mongoose.connect('mongodb+srv://ece1saikumar:hyaDfmoR4xRStmYe@tenants.orhtp.mongodb.net/?retryWrites=true&w=majority&appName=Tenants', { useNewUrlParser: true, useUnifiedTopology: true });

// Import routes
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');

app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);

app.listen(process.env.PORT || 3000, () => {
    console.log('Server is running...');
});
