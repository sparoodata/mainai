const Sentry = require('../services/sentry');

module.exports = (err, req, res, next) => {
  if (Sentry && Sentry.captureException) {
    Sentry.captureException(err);
  }
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
};
