const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

let pool = null;
let reconnectPromise = null;

const DEFAULT_CA_PATH = path.resolve(__dirname, 'global-bundle.pem');
const REQUIRED_DB_ENV_VARS = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const RECOVERABLE_DB_ERROR_CODES = new Set([
  'ECONNRESET',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
]);
const DEFAULT_CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_CONNECT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 5000;

const requireEnv = (name) => {
  const value = String(process.env[name] || '').trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

const getMissingDbEnvVars = () => {
  return REQUIRED_DB_ENV_VARS.filter((name) => !String(process.env[name] || '').trim());
};

const getCaCertificate = () => {
  const configuredPath = String(process.env.DB_SSL_CA_PATH || '').trim();
  const caPath = configuredPath
    ? path.resolve(__dirname, '..', configuredPath)
    : DEFAULT_CA_PATH;

  if (!fs.existsSync(caPath)) {
    throw new Error(
      `AWS RDS CA bundle not found at ${caPath}. Place global-bundle.pem there or set DB_SSL_CA_PATH.`
    );
  }

  return fs.readFileSync(caPath, 'utf8');
};

const buildMysqlConfig = () => {
  const port = Number(process.env.DB_PORT || 3306);
  const connectTimeout = Number(process.env.DB_CONNECT_TIMEOUT_MS || DEFAULT_CONNECT_TIMEOUT_MS);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('DB_PORT must be a valid positive integer');
  }

  if (!Number.isInteger(connectTimeout) || connectTimeout <= 0) {
    throw new Error('DB_CONNECT_TIMEOUT_MS must be a valid positive integer');
  }

  return {
    host: requireEnv('DB_HOST'),
    port,
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    database: requireEnv('DB_NAME'),
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    connectTimeout,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    ssl: {
      ca: getCaCertificate(),
      rejectUnauthorized: true,
    },
  };
};

const isRecoverableDbError = (error) => {
  const code = String(error?.code || '').trim().toUpperCase();
  return RECOVERABLE_DB_ERROR_CODES.has(code);
};

const createPoolAndPing = async () => {
  const config = buildMysqlConfig();
  const nextPool = mysql.createPool(config);
  const connection = await nextPool.getConnection();

  try {
    await connection.ping();
  } finally {
    connection.release();
  }

  return nextPool;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getStartupRetryConfig = () => {
  const retries = Number(process.env.DB_CONNECT_RETRIES || DEFAULT_CONNECT_RETRIES);
  const delayMs = Number(process.env.DB_CONNECT_RETRY_DELAY_MS || DEFAULT_RETRY_DELAY_MS);

  return {
    retries: Number.isInteger(retries) && retries >= 0 ? retries : DEFAULT_CONNECT_RETRIES,
    delayMs: Number.isInteger(delayMs) && delayMs >= 0 ? delayMs : DEFAULT_RETRY_DELAY_MS,
  };
};

const reconnectPool = async () => {
  if (reconnectPromise) {
    return reconnectPromise;
  }

  reconnectPromise = (async () => {
    const previousPool = pool;

    try {
      pool = await createPoolAndPing();
      if (previousPool) {
        await previousPool.end().catch(() => {});
      }
      return pool;
    } catch (error) {
      pool = null;
      throw error;
    } finally {
      reconnectPromise = null;
    }
  })();

  return reconnectPromise;
};

const withDbReconnect = async (operation, label = 'query') => {
  try {
    return await operation();
  } catch (error) {
    if (!isRecoverableDbError(error)) {
      throw error;
    }

    console.warn(`MySQL ${label} failed with ${error.code}; retrying after pool reconnect.`);
    await reconnectPool();
    return operation();
  }
};

const dbPoolFacade = {
  query: (...args) => withDbReconnect(() => pool.query(...args), 'query'),
  execute: (...args) => withDbReconnect(() => pool.execute(...args), 'execute'),
  getConnection: () => withDbReconnect(() => pool.getConnection(), 'getConnection'),
  end: async () => {
    if (!pool) {
      return;
    }

    const activePool = pool;
    pool = null;
    await activePool.end();
  },
};

const connectDB = async () => {
  if (pool) {
    return dbPoolFacade;
  }

  const missingDbEnvVars = getMissingDbEnvVars();

  if (missingDbEnvVars.length > 0) {
    throw new Error(
      `Missing required database environment variables: ${missingDbEnvVars.join(', ')}. ` +
        'Set these in your Render service Environment settings.'
    );
  }

  const { retries, delayMs } = getStartupRetryConfig();
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      pool = await createPoolAndPing();

      console.log('MySQL Connected Successfully');
      return dbPoolFacade;
    } catch (error) {
      lastError = error;

      if (pool) {
        await pool.end().catch(() => {});
        pool = null;
      }

      if (attempt < retries && isRecoverableDbError(error)) {
        console.warn(
          `MySQL connect attempt ${attempt + 1} of ${retries + 1} failed with ${error.code}; retrying in ${delayMs}ms.`
        );
        await sleep(delayMs);
        continue;
      }

      throw error;
    }
  }

  throw lastError;
};

const getDbPool = () => (pool ? dbPoolFacade : null);

module.exports = {
  connectDB,
  getDbPool,
  getMissingDbEnvVars,
};
