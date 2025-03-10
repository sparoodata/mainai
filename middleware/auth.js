const Authorize = require('../models/Authorize');
const User = require('../models/User');

async function checkAuthorization(req, res, next) {
  const id = req.params.id;

  try {
    const authorizeRecord = await Authorize.findById(id);
    if (!authorizeRecord) {
      return res.status(404).json({ error: 'Authorization record not found.' });
    }
    if (authorizeRecord.used) {
      return res.status(403).json({ error: 'This link has already been used.' });
    }

    const user = await User.findOne({ phoneNumber: authorizeRecord.phoneNumber });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    req.authorizeRecord = authorizeRecord;
    req.user = user;
    next();
  } catch (error) {
    console.error('Authorization error:', error);
    res.status(500).json({ error: 'An error occurred during authorization.' });
  }
}

module.exports = checkAuthorization;