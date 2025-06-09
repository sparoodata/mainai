const Sentry = require('@sentry/node');

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({ dsn, tracesSampleRate: 1.0 });
  console.log('Sentry initialized');
}

module.exports = Sentry;
