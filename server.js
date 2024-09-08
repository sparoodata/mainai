


const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const path = require('path'); // For serving static files
const app = express();
require('dotenv').config();

// Middlewares
app.use(bodyParser.json());
app.use(express.static('public'));

// MongoDB connection
mongoose.connect('mongodb+srv://ece1saikumar:hyaDfmoR4xRStmYe@tenants.orhtp.mongodb.net/?retryWrites=true&w=majority&appName=Tenants', { useNewUrlParser: true, useUnifiedTopology: true });

// Routes
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');

// Serve static HTML files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.use('/auth', authRoutes);

// Catch-all route for dashboard to serve the HTML file
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// Start server
app.listen(process.env.PORT || 3000, () => {
    console.log('Server is running...');
});
