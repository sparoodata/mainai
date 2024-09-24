require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const generateOTP = require('./utils/generateOTP'); // Utility to generate OTP
const User = require('./models/User'); 
const Tenant = require('./models/Tenant');

const app = express();
const port = 3000;

// Verify OTP Route
app.post('/verify-otp', [
    body('phoneNumber').isMobilePhone().withMessage('Invalid phone number'),
    body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
], async (req, res) => {
    const { phoneNumber, otp } = req.body;
  console.log(req.body);
     
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    try {
        // Find the user by phone number
        const user = await User.findOne({ phoneNumber });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Check if the OTP matches and is not expired
        if (user.otp === otp && user.otpExpiresAt > Date.now()) {
            // OTP is valid, mark the user as verified
            user.verified = true;
            user.otp = undefined; // Remove the OTP
            user.otpExpiresAt = undefined; // Remove OTP expiration time
            await user.save();

            console.log('User verified successfully:', phoneNumber);

            // Optionally send a success message to WhatsApp
            await axios.post(WHATSAPP_API_URL, {
                messaging_product: 'whatsapp',
                to: phoneNumber,
                type: 'template',
                template: {
                    name: 'registration_success',  // Ensure this template exists
                    language: { code: 'en' }
                }
            }, {
               headers: {
                    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });

            return res.json({ message: 'User verified successfully' });
        } else {
            console.log('Invalid or expired OTP for:', phoneNumber);

         

            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }
    } catch (error) {
        console.error('Error verifying OTP:', error.response ? error.response.data : error);
        res.status(500).json({ error: 'OTP verification failed' });
    }
});

