// utils/generateOTP.js
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString(); // Generates a 6-digit OTP as a string
}

module.exports = generateOTP;
