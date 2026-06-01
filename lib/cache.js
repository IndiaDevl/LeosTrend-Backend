const Redis = require("ioredis");

const REDIS_URL = String(process.env.REDIS_URL || "").trim();
const CACHE_KEY_PREFIX = String(process.env.CACHE_KEY_PREFIX || "leostrend").trim() || "leostrend";

let redisClientPromise = null;
let redisUnavailable = false;
let redisWarningLogged = false;

const logRedisWarning = (message, error) => {
  if (redisWarningLogged) {
    return;
  }

  redisWarningLogged = true;
  console.warn(`[CACHE] ${message}${error?.message ? `: ${error.message}` : ""}`);
};

const getCacheKey = (key) => `${CACHE_KEY_PREFIX}:${String(key || "").trim()}`;

const getRedisClient = async () => {
  if (!REDIS_URL || redisUnavailable) {
    return null;
  }

  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const client = new Redis(REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });

      client.on("error", (error) => {
        logRedisWarning("Redis client error; continuing without shared cache", error);
      });

      await client.connect();
      return client;
    })();
  }

  try {
    return await redisClientPromise;
  } catch (error) {
    redisUnavailable = true;
    redisClientPromise = null;
    logRedisWarning("Failed to connect to Redis; continuing without shared cache", error);
    return null;
  }
};

const getJsonFromSharedCache = async (key) => {
  const client = await getRedisClient();
  if (!client) {
    return null;
  }

  try {
    const value = await client.get(getCacheKey(key));
    return value ? JSON.parse(value) : null;
  } catch (error) {
    logRedisWarning("Failed to read from Redis shared cache", error);
    return null;
  }
};

const setJsonInSharedCache = async (key, value, ttlMs) => {
  const client = await getRedisClient();
  if (!client) {
    return false;
  }

  try {
    const ttlSeconds = Math.max(1, Math.ceil(Number(ttlMs || 0) / 1000));
    await client.set(getCacheKey(key), JSON.stringify(value), "EX", ttlSeconds);
    return true;
  } catch (error) {
    logRedisWarning("Failed to write to Redis shared cache", error);
    return false;
  }
};

const deleteFromSharedCache = async (keys) => {
  const client = await getRedisClient();
  if (!client) {
    return 0;
  }

  const normalizedKeys = (Array.isArray(keys) ? keys : [keys])
    .map((key) => getCacheKey(key))
    .filter(Boolean);

  if (normalizedKeys.length === 0) {
    return 0;
  }

  try {
    return await client.del(...normalizedKeys);
  } catch (error) {
    logRedisWarning("Failed to invalidate Redis shared cache", error);
    return 0;
  }
};

const isSharedCacheEnabled = () => Boolean(REDIS_URL) && !redisUnavailable;

module.exports = {
  deleteFromSharedCache,
  getJsonFromSharedCache,
  isSharedCacheEnabled,
  setJsonInSharedCache,
};