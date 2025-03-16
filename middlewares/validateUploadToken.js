// middlewares/validateUploadToken.js
const UploadToken = require('../models/UploadToken');

async function validateUploadToken(req, res, next) {
  // For GET requests, token is in query; for POST, in body
  const token = req.method === 'GET' ? req.query.token : req.body.token;
  console.log(`Validating token: ${token}, Method: ${req.method}`);

  if (!token) {
    console.log('No token provided in request');
    return res.status(403).send('No token provided.');
  }

  try {
    const uploadToken = await UploadToken.findOne({ token });
    if (!uploadToken) {
      console.log('Token not found in database');
      return res.status(403).send('Invalid or expired token.');
    }
    if (uploadToken.used) {
      console.log('Token already used');
      return res.status(403).send('This upload link has already been used.');
    }
    if (new Date() > uploadToken.expiresAt) {
      console.log('Token expired');
      return res.status(403).send('This upload link has expired.');
    }
    req.uploadToken = uploadToken;
    next();
  } catch (error) {
    console.error('Error validating token:', error);
    return res.status(500).send('Server error during token validation.');
  }
}

module.exports = validateUploadToken;
