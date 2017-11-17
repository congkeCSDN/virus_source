const redis = require('redis');
const bluebird = require('bluebird');
const config = require('./config');

global.globalRedisClient = {};

// 目前:
// redis-session存在0库  这个主要存储session
// 业务数据记录在1库
// 获取微信信息的token存在2库

// 所有项目的总积分存在3库里 便于通用积分商城的使用
module.exports = function (type) {
  const redisConfig = config.redisConfig || { host: '127.0.0.1', port: '6379' };
  const clientType = type ? parseInt(type, 0) : 0;

  if (!global.globalRedisClient[clientType]) {
    if (clientType === 1) {
      redisConfig.db = 1;
    } else if (clientType === 2) {
      redisConfig.db = 2;
    } else if (clientType === 3) {
      redisConfig.db = 3;
    } else {
      redisConfig.db = 0;
    }

    const client = redis.createClient(redisConfig);
    bluebird.promisifyAll(redis.RedisClient.prototype);

    bluebird.promisifyAll(redis.Multi.prototype);

    client.on('error', (err) => {
      console.log(`Error: ${err}`);
    });
    global.globalRedisClient[clientType] = client;
  }

  return global.globalRedisClient[clientType];
};
