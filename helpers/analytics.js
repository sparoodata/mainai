const pino = require('pino');
const logger = pino();

async function track(event, data = {}) {
  logger.info({ event, ...data }, 'analytics');
}

module.exports = { track };
