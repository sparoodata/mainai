const redis = require('redis');

const client = redis.createClient({
  url: process.env.REDIS_URL || 'rediss://default:AezpAAIjcDEwOWU2NWVlODdhZDA0OGM4ODdkNmYxODM2MWM1ODFjNnAxMA@dominant-walrus-60649.upstash.io:6379',
});

client.on('error', (err) => console.error('Redis error:', err));
client.connect();

module.exports = client;


