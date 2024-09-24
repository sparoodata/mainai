const User = require('../models/User');

// Function to verify OTP
async function verifyOTP(phoneNumber, providedOtp) {
    try {
        // Find the user by phone number
        const user = await User.findOne({ phoneNumber });

        if (!user) {
            return { success: false, message: 'User not found.' };
        }

        // Check if the OTP matches
        if (user.otp !== providedOtp) {
            return { success: false, message: 'Invalid OTP.' };
        }

        // Check if the OTP has expired
        const currentTime = Date.now();
        if (currentTime > new Date(user.otpExpiration)) {
            return { success: false, message: 'OTP expired.' };
        }

        // If OTP is valid, clear the OTP fields and mark user as verified
        user.verified = true;
        user.otp = null;  // Clear OTP after verification
        user.otpExpiration = null;
        await user.save();

        return { success: true, message: 'OTP verified successfully.' };
    } catch (error) {
        console.error('Error verifying OTP:', error);
        return { success: false, message: 'Server error. Please try again later.' };
    }
}

module.exports = verifyOTP;
