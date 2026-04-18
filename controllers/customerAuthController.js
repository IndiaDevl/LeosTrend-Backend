const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDbPool } = require('../config/db');

const CUSTOMERS_TABLE = 'customers';
const SALT_ROUNDS = 10;

let customerStoreReadyPromise = null;

const asyncHandler = (handler) => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    return res.status(statusCode).json({
      message: error.message || 'Unexpected server error',
    });
  }
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizePhone = (value) => String(value || '').replace(/\D/g, '').slice(-10);

const getPoolOrThrow = () => {
  const pool = getDbPool();

  if (!pool) {
    const error = new Error('MySQL pool is not initialized');
    error.statusCode = 503;
    throw error;
  }

  return pool;
};

const getCustomerJwtSecret = () => {
  return process.env.CUSTOMER_JWT_SECRET || process.env.ADMIN_JWT_SECRET || 'leostrend-customer-dev-secret';
};

const buildCustomerProfile = (row) => ({
  id: String(row.id),
  userId: String(row.id),
  name: String(row.name || ''),
  email: normalizeEmail(row.email),
  phone: String(row.phone || ''),
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
});

const createCustomerToken = (customer) => {
  return jwt.sign(
    {
      role: 'customer',
      sub: String(customer.id),
      email: normalizeEmail(customer.email),
      jti: crypto.randomUUID(),
    },
    getCustomerJwtSecret(),
    { expiresIn: '30d' }
  );
};

const ensureCustomerStore = async () => {
  if (customerStoreReadyPromise) {
    return customerStoreReadyPromise;
  }

  customerStoreReadyPromise = (async () => {
    const pool = getPoolOrThrow();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${CUSTOMERS_TABLE} (
        id CHAR(36) NOT NULL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(191) NOT NULL,
        phone VARCHAR(32) DEFAULT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_customers_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  })();

  try {
    await customerStoreReadyPromise;
  } catch (error) {
    customerStoreReadyPromise = null;
    throw error;
  }
};

const getCustomerById = async (customerId) => {
  await ensureCustomerStore();
  const pool = getPoolOrThrow();
  const [rows] = await pool.query(
    `SELECT id, name, email, phone, created_at, updated_at FROM ${CUSTOMERS_TABLE} WHERE id = ? LIMIT 1`,
    [String(customerId)]
  );

  return Array.isArray(rows) && rows[0] ? buildCustomerProfile(rows[0]) : null;
};

const getCustomerAuthToken = (req) => {
  const authHeader = req.headers.authorization || '';

  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  return '';
};

const verifyCustomerToken = (token) => {
  try {
    const payload = jwt.verify(token, getCustomerJwtSecret());

    if (payload?.role !== 'customer' || !payload?.sub) {
      return { valid: false };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
};

const customerAuth = asyncHandler(async (req, res, next) => {
  const token = getCustomerAuthToken(req);
  const verification = verifyCustomerToken(token);

  if (!verification.valid) {
    return res.status(401).json({ message: 'Customer access denied' });
  }

  const customer = await getCustomerById(verification.payload.sub);
  if (!customer) {
    return res.status(401).json({ message: 'Customer account not found' });
  }

  req.customer = customer;
  req.customerToken = token;
  next();
});

const sendAuthResponse = (res, customerProfile, statusCode = 200) => {
  return res.status(statusCode).json({
    token: createCustomerToken(customerProfile),
    user: customerProfile,
  });
};

exports.registerCustomer = asyncHandler(async (req, res) => {
  await ensureCustomerStore();
  const pool = getPoolOrThrow();

  const name = String(req.body.name || '').trim();
  const email = normalizeEmail(req.body.email);
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || '');

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email, and password are required' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Enter a valid email address' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters long' });
  }

  const [existingRows] = await pool.query(
    `SELECT id FROM ${CUSTOMERS_TABLE} WHERE email = ? LIMIT 1`,
    [email]
  );

  if (Array.isArray(existingRows) && existingRows.length > 0) {
    return res.status(409).json({ message: 'An account with this email already exists' });
  }

  const customerId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  await pool.query(
    `INSERT INTO ${CUSTOMERS_TABLE} (id, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)`,
    [customerId, name, email, phone || null, passwordHash]
  );

  const customerProfile = await getCustomerById(customerId);
  return sendAuthResponse(res, customerProfile, 201);
});

exports.loginCustomer = asyncHandler(async (req, res) => {
  await ensureCustomerStore();
  const pool = getPoolOrThrow();

  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  const [rows] = await pool.query(
    `SELECT id, name, email, phone, password_hash, created_at, updated_at FROM ${CUSTOMERS_TABLE} WHERE email = ? LIMIT 1`,
    [email]
  );

  const customerRow = Array.isArray(rows) ? rows[0] : null;
  if (!customerRow) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  const passwordOk = await bcrypt.compare(password, customerRow.password_hash);
  if (!passwordOk) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  return sendAuthResponse(res, buildCustomerProfile(customerRow));
});

exports.getCurrentCustomer = asyncHandler(async (req, res) => {
  return res.json({ user: req.customer });
});

exports.customerAuth = customerAuth;
exports.ensureCustomerStore = ensureCustomerStore;