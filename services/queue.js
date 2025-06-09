const { Queue, Worker } = require('bullmq');
const redis = require('./redis');

const connection = redis.duplicate();

const jobQueue = new Queue('jobs', { connection });

function createWorker(name, processor) {
  return new Worker(name, processor, { connection });
}

module.exports = { jobQueue, createWorker };
