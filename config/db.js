const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

let pool = null;

const DEFAULT_CA_PATH = path.resolve(__dirname, 'global-bundle.pem');
const REQUIRED_DB_ENV_VARS = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];

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

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('DB_PORT must be a valid positive integer');
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
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    ssl: {
      ca: getCaCertificate(),
      rejectUnauthorized: true,
    },
  };
};

const connectDB = async () => {
  if (pool) {
    return pool;
  }

  try {
    const missingDbEnvVars = getMissingDbEnvVars();

    if (missingDbEnvVars.length > 0) {
      throw new Error(
        `Missing required database environment variables: ${missingDbEnvVars.join(', ')}. ` +
          'Set these in your Render service Environment settings.'
      );
    }

    const config = buildMysqlConfig();
    pool = mysql.createPool(config);

    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();

    console.log('MySQL Connected Successfully');
    return pool;
  } catch (error) {
    if (pool) {
      await pool.end().catch(() => {});
      pool = null;
    }

    throw error;
  }
};

const getDbPool = () => pool;

module.exports = {
  connectDB,
  getDbPool,
  getMissingDbEnvVars,
};
