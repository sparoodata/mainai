const express = require('express');
const User = require('../models/User');
const router = express.Router();

// POST route for verifying OTP
router.post('/', async (req, res) => {
    const { phoneNumber, otp } = req.body;

    try {
        // Find the user by phone number
        const user = await User.findOne({ phoneNumber });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        console.log('Stored OTP:', user.otp); // Debugging output
        console.log('Stored OTP Expiry (timestamp):', new Date(user.otpExpiresAt).getTime()); // Debugging output
        console.log('Current time (timestamp):', Date.now()); // Debugging output

        // Check if the OTP matches and if it's still valid (within expiration time)
        if (user.otp === otp && Date.now() < new Date(user.otpExpiresAt).getTime()) {
            // OTP is correct, verify the user
            user.verified = true;
            user.otp = undefined; // Clear OTP after verification
            user.otpExpiresAt = undefined; // Clear OTP expiration
            user.verifiedDate = new Date(); // Save the verified date
            await user.save();

            return res.status(200).json({ message: 'OTP verified successfully', user });
        } else {
            // OTP is either incorrect or expired
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }
    } catch (error) {
        console.error('Error verifying OTP:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
