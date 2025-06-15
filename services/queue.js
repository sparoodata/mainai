const { Queue, Worker } = require('bullmq');
const redis = require('./redis');

// Reuse the same Redis instance to avoid exhausting the connection limit
const connection = redis;

const jobQueue = new Queue('jobs', { connection });

function createWorker(name, processor) {
  return new Worker(name, processor, { connection });
}

module.exports = { jobQueue, createWorker };
